import { randomUUID } from "node:crypto";
import type {
	ApiErrorDetail,
	AssistantEvent,
	ChatMessage,
	JsonObject,
	JsonValue,
	TaskSnapshot,
	TaskStatus,
	ToolCall,
} from "@pi-vue3/protocol";
import { isTerminalTaskStatus } from "@pi-vue3/protocol";
import { HttpError } from "./errors.js";
import { SessionStore, type StoredSession, type StoredTask } from "./session-store.js";
import type { AgentRuntime, AgentRuntimeCallbacks, SubmitTaskRequest } from "./runtime-types.js";

const MAX_EVENT_COUNT = 200;
const MAX_TOOL_TEXT_LENGTH = 8_000;

interface ActiveControl {
	controller: AbortController;
	done: Promise<void>;
	resolveDone: () => void;
	cancelRequested: boolean;
	shutdownRequested: boolean;
}

function appendEvent(
	task: StoredTask,
	type: AssistantEvent["type"],
	payload: AssistantEvent["payload"],
): AssistantEvent {
	task.seq += 1;
	const event = {
		type,
		sessionId: task.sessionId,
		taskId: task.taskId,
		traceId: task.traceId,
		seq: task.seq,
		occurredAt: new Date().toISOString(),
		payload,
	} as AssistantEvent;
	task.events.push(event);
	if (task.events.length > MAX_EVENT_COUNT) task.events.splice(0, task.events.length - MAX_EVENT_COUNT);
	return event;
}

function toJsonValue(value: unknown, depth = 0): JsonValue {
	if (depth > 8) return "[depth limit]";
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => toJsonValue(item, depth + 1));
	if (typeof value === "object") {
		const output: JsonObject = {};
		for (const [key, item] of Object.entries(value).slice(0, 100)) {
			if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
			output[key] = toJsonValue(item, depth + 1);
		}
		return output;
	}
	return String(value);
}

function toJsonObject(value: unknown): JsonObject {
	const converted = toJsonValue(value);
	return typeof converted === "object" && converted !== null && !Array.isArray(converted) ? converted : {};
}

function safeToolResult(value: unknown): JsonValue {
	if (typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content)) {
		const text = value.content
			.filter((part): part is { type: "text"; text: string } =>
				typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n")
			.slice(0, MAX_TOOL_TEXT_LENGTH);
		const details = "details" in value ? toJsonValue(value.details) : {};
		return { text, details };
	}
	const converted = toJsonValue(value);
	if (typeof converted === "string") return converted.slice(0, MAX_TOOL_TEXT_LENGTH);
	return converted;
}

function eventStatus(status: TaskStatus): "completed" | "failed" | "cancelled" | "interrupted" {
	return status === "running" || status === "queued" ? "interrupted" : status;
}

function promptFor(text: string, context?: JsonObject): string {
	if (!context || Object.keys(context).length === 0) return text;
	return `${text}\n\nUntrusted page context (JSON):\n${JSON.stringify(context)}`;
}

export class TaskManager {
	private readonly active = new Map<string, ActiveControl>();
	private readonly listeners = new Map<string, Set<(event: AssistantEvent) => void>>();

	constructor(private readonly store: SessionStore, private readonly runtime: AgentRuntime) {}

	async submit(sessionId: string, request: SubmitTaskRequest): Promise<TaskSnapshot> {
		if (!request.text.trim()) throw new HttpError(400, "invalid_task", "Task text cannot be empty.");
		const taskId = randomUUID();
		const traceId = randomUUID();
		const userMessage: ChatMessage = {
			id: randomUUID(),
			taskId,
			role: "user",
			text: request.text,
			status: "completed",
			createdAt: new Date().toISOString(),
		};
		const created = await this.store.startTask({
			sessionId,
			taskId,
			traceId,
			...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
			userMessage,
		});
		if (!created.created) return created.task;

		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => { resolveDone = resolve; });
		const control: ActiveControl = {
			controller: new AbortController(),
			done,
			resolveDone,
			cancelRequested: false,
			shutdownRequested: false,
		};
		this.active.set(taskId, control);
		void this.runTask(taskId, sessionId, request.text, request.context, control);
		return created.task;
	}

	getTask(taskId: string): TaskSnapshot {
		const task = this.store.getTask(taskId);
		if (!task) throw new HttpError(404, "task_not_found", "Task not found.");
		return task;
	}

	async cancel(taskId: string): Promise<TaskSnapshot> {
		const task = this.store.getTask(taskId);
		if (!task) throw new HttpError(404, "task_not_found", "Task not found.");
		if (isTerminalTaskStatus(task.status)) return task;

		await this.store.updateTask(taskId, (current) => {
			if (!isTerminalTaskStatus(current.status)) current.cancelRequested = true;
		});
		const control = this.active.get(taskId);
		if (!control) {
			await this.finish(taskId, "cancelled");
			return this.getTask(taskId);
		}
		control.cancelRequested = true;
		control.controller.abort();
		await control.done;
		return this.getTask(taskId);
	}

	replay(taskId: string, after: number): ReturnType<SessionStore["getReplay"]> {
		return this.store.getReplay(taskId, after);
	}

	subscribe(taskId: string, listener: (event: AssistantEvent) => void): () => void {
		if (!this.store.getTask(taskId)) throw new HttpError(404, "task_not_found", "Task not found.");
		let subscribers = this.listeners.get(taskId);
		if (!subscribers) this.listeners.set(taskId, (subscribers = new Set()));
		subscribers.add(listener);
		return () => {
			subscribers?.delete(listener);
			if (subscribers?.size === 0) this.listeners.delete(taskId);
		};
	}

	async waitForTask(taskId: string): Promise<void> {
		await this.active.get(taskId)?.done;
	}

	async shutdown(): Promise<void> {
		const controls = [...this.active.entries()];
		for (const [, control] of controls) {
			control.shutdownRequested = true;
			control.controller.abort();
		}
		await Promise.all(controls.map(([, control]) => control.done));
	}

	private async runTask(
		taskId: string,
		sessionId: string,
		text: string,
		context: JsonObject | undefined,
		control: ActiveControl,
	): Promise<void> {
		let eventTail = Promise.resolve();
		const serial = <T>(operation: () => Promise<T>): Promise<T> => {
			const pending = eventTail.then(operation);
			eventTail = pending.then(() => undefined, () => undefined);
			return pending;
		};
		const callbacks: AgentRuntimeCallbacks = {
			onMessageStart: (_runtimeMessageId) => serial(async () => {
				const message: ChatMessage = {
					id: randomUUID(), taskId, role: "assistant", text: "", status: "streaming", createdAt: new Date().toISOString(),
				};
				await this.mutate(taskId, "message.upserted", { message }, (task, session) => {
					task.messages.push(message);
					session.messages.push(message);
				});
				return message.id;
			}),
			onTextDelta: (messageId, delta) => serial(async () => {
				if (!delta) return;
				let updated = false;
				const event = await this.emit(taskId, "message.delta", { messageId, delta }, (task, session) => {
					const message = task.messages.find((candidate) => candidate.id === messageId && candidate.status === "streaming");
					if (!message) return;
					message.text += delta;
					updated = true;
					const stored = session.messages.find((candidate) => candidate.id === messageId);
					if (stored) stored.text = message.text;
				});
				if (updated) this.notify(taskId, event);
			}),
			onMessageEnd: (messageId, status = "completed") => serial(async () => {
				const task = this.store.getTaskRecord(taskId);
				const message = task?.messages.find((candidate) => candidate.id === messageId);
				if (!message || message.status !== "streaming") return;
				const completed = { ...message, status };
				await this.mutate(taskId, "message.upserted", { message: completed }, (current, session) => {
					const item = current.messages.find((candidate) => candidate.id === messageId);
					if (item) item.status = status;
					const stored = session.messages.find((candidate) => candidate.id === messageId);
					if (stored) stored.status = status;
				});
			}),
			onToolStart: (toolCallId, name, args) => serial(async () => {
				const now = new Date().toISOString();
				const tool: ToolCall = {
					id: toolCallId || randomUUID(), taskId, name: name.slice(0, 120), arguments: toJsonObject(args),
					status: "running", createdAt: now, startedAt: now,
				};
				await this.mutate(taskId, "tool.upserted", { tool }, (task, session) => {
					task.tools.push(tool);
					session.tools.push(tool);
				});
			}),
			onToolEnd: (toolCallId, result, isError) => serial(async () => {
				const task = this.store.getTaskRecord(taskId);
				const existing = task?.tools.find((candidate) => candidate.id === toolCallId);
				if (!existing) return;
				const status = control.shutdownRequested
					? "interrupted"
					: control.cancelRequested || task?.cancelRequested
						? "cancelled"
						: isError ? "failed" : "completed";
				const tool: ToolCall = {
					...existing, result: safeToolResult(result), status, completedAt: new Date().toISOString(),
				};
				await this.mutate(taskId, "tool.upserted", { tool }, (current, session) => {
					const stored = current.tools.find((candidate) => candidate.id === toolCallId);
					if (stored) Object.assign(stored, tool);
					const historical = session.tools.find((candidate) => candidate.id === toolCallId);
					if (historical) Object.assign(historical, tool);
				});
			}),
			onSessionFile: (sessionFile) => serial(async () => {
				await this.store.setPiSessionFile(sessionId, sessionFile);
			}),
		};

		try {
			if (control.cancelRequested) {
				await this.finish(taskId, "cancelled");
				return;
			}
			const result = await this.runtime.run({
				sessionId,
				sessionFile: this.store.getPiSessionFile(sessionId),
				prompt: promptFor(text, context),
				signal: control.controller.signal,
				callbacks,
			});
			if (result?.sessionFile) await callbacks.onSessionFile(result.sessionFile);
			await eventTail;
			const storedTask = this.store.getTaskRecord(taskId);
			const status: TaskStatus = control.shutdownRequested
				? "interrupted"
				: control.cancelRequested || storedTask?.cancelRequested ? "cancelled" : "completed";
			await this.finish(taskId, status);
		} catch {
			await eventTail;
			const storedTask = this.store.getTaskRecord(taskId);
			const status: TaskStatus = control.shutdownRequested
				? "interrupted"
				: control.cancelRequested || storedTask?.cancelRequested ? "cancelled" : "failed";
			const error: ApiErrorDetail | undefined = status === "failed"
				? {
					code: "assistant_runtime_error",
					message: "The assistant could not complete this task. Check the server configuration and try again.",
					...(storedTask ? { traceId: storedTask.traceId } : {}),
				}
				: undefined;
			await this.finish(taskId, status, error);
		} finally {
			this.active.delete(taskId);
			control.resolveDone();
		}
	}

	private async mutate(
		taskId: string,
		type: AssistantEvent["type"],
		payload: AssistantEvent["payload"],
		update: (task: StoredTask, session: StoredSession) => void,
	): Promise<void> {
		const event = await this.emit(taskId, type, payload, update);
		this.notify(taskId, event);
	}

	private async emit(
		taskId: string,
		type: AssistantEvent["type"],
		payload: AssistantEvent["payload"],
		update?: (task: StoredTask, session: StoredSession) => void,
	): Promise<AssistantEvent> {
		let emitted!: AssistantEvent;
		await this.store.updateTask(taskId, (task, session) => {
			update?.(task, session);
			emitted = appendEvent(task, type, payload);
		});
		return emitted;
	}

	private notify(taskId: string, event: AssistantEvent): void {
		for (const listener of this.listeners.get(taskId) ?? []) listener(structuredClone(event));
	}

	private async finish(taskId: string, requestedStatus: TaskStatus, error?: ApiErrorDetail): Promise<void> {
		if (!isTerminalTaskStatus(requestedStatus)) return;
		let emitted: AssistantEvent | undefined;
		await this.store.updateTask(taskId, (task, session) => {
			if (isTerminalTaskStatus(task.status)) return;
			const status = task.cancelRequested
				&& (requestedStatus === "completed" || requestedStatus === "failed")
				? "cancelled"
				: requestedStatus;
			task.status = status;
			if (status === "failed") {
				task.error = error ?? { code: "assistant_runtime_error", message: "The assistant could not complete this task.", traceId: task.traceId };
			} else {
				delete task.error;
			}
			const messageStatus = status === "completed" ? "completed" : eventStatus(status);
			for (const message of task.messages) {
				if (message.status === "streaming") message.status = messageStatus;
			}
			for (const tool of task.tools) {
				if (tool.status === "running" || tool.status === "pending") {
					tool.status = status === "completed" ? "completed" : eventStatus(status);
					tool.completedAt = new Date().toISOString();
				}
			}
			session.messages = session.messages.map((message) => {
				const updated = task.messages.find((candidate) => candidate.id === message.id);
				return updated ? structuredClone(updated) : message;
			});
			session.tools = session.tools.map((tool) => {
				const updated = task.tools.find((candidate) => candidate.id === tool.id);
				return updated ? structuredClone(updated) : tool;
			});
			if (session.activeTaskId === taskId) delete session.activeTaskId;
			session.updatedAt = new Date().toISOString();
			emitted = appendEvent(task, "task.status", {
				status,
				...(status === "failed" ? { error: task.error } : {}),
			});
		});
		if (emitted) this.notify(taskId, emitted);
	}
}
