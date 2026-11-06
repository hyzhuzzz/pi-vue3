import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import type {
	AssistantEvent,
	ChatMessage,
	SessionDetail,
	SessionSummary,
	TaskSnapshot,
	TaskStatus,
	ToolCall,
} from "@pi-vue3/protocol";
import { HttpError } from "./errors.js";

const STATE_VERSION = 1;
const DEFAULT_EVENT_LIMIT = 200;
const DEFAULT_TITLE = "New conversation";

export interface StoredSession extends SessionDetail {
	piSessionFile?: string;
}

export interface StoredTask extends TaskSnapshot {
	events: AssistantEvent[];
	cancelRequested: boolean;
	clientRequestId?: string;
}

interface PersistedState {
	version: number;
	sessions: Record<string, StoredSession>;
	tasks: Record<string, StoredTask>;
}

export interface SessionStoreOptions {
	dataDir: string;
	eventLimit?: number;
}

export interface StartTaskInput {
	sessionId: string;
	taskId: string;
	traceId: string;
	clientRequestId?: string;
	userMessage: ChatMessage;
}

export interface StartTaskResult {
	created: boolean;
	task: TaskSnapshot;
}

function taskSnapshot(task: StoredTask): TaskSnapshot {
	const { events: _events, cancelRequested: _cancelRequested, clientRequestId: _clientRequestId, ...snapshot } = task;
	return structuredClone(snapshot);
}

function taskIsTerminal(status: TaskStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function makeEvent(
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
		payload: structuredClone(payload),
	} as AssistantEvent;
	task.events.push(event);
	return event;
}

function titleFromText(text: string): string {
	const compact = text.trim().replace(/\s+/g, " ");
	return compact.length > 60 ? `${compact.slice(0, 57)}…` : compact || DEFAULT_TITLE;
}

function inside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function insideOrEqual(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class SessionStore {
	readonly dataDir: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly workDir: string;
	private readonly metadataPath: string;
	private readonly eventLimit: number;
	private state: PersistedState = { version: STATE_VERSION, sessions: {}, tasks: {} };
	private initialized = false;
	private writeTail: Promise<void> = Promise.resolve();

	constructor(options: SessionStoreOptions) {
		this.dataDir = resolve(options.dataDir);
		this.agentDir = join(this.dataDir, "pi-agent");
		this.sessionDir = join(this.dataDir, "pi-sessions");
		this.workDir = join(this.dataDir, "work");
		this.metadataPath = join(this.dataDir, "metadata.json");
		this.eventLimit = Math.max(20, options.eventLimit ?? DEFAULT_EVENT_LIMIT);
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		await mkdir(this.dataDir, { recursive: true });
		await Promise.all([
			mkdir(this.agentDir, { recursive: true }),
			mkdir(this.sessionDir, { recursive: true }),
			mkdir(this.workDir, { recursive: true }),
		]);
		try {
			const raw = await readFile(this.metadataPath, "utf8");
			const state: unknown = JSON.parse(raw);
			if (!isPersistedState(state)) throw new Error("metadata schema is unsupported");
			this.state = state;
		} catch (error) {
			if (isFileNotFound(error)) {
				this.state = { version: STATE_VERSION, sessions: {}, tasks: {} };
			} else {
				throw new Error("Assistant metadata could not be read. Preserve the data directory and repair metadata.json before restarting.");
			}
		}
		this.initialized = true;
		await this.recoverInterruptedTasks();
	}

	private assertInitialized(): void {
		if (!this.initialized) throw new Error("SessionStore.init() must complete before use");
	}

	private async withWrite<T>(operation: () => Promise<T> | T): Promise<T> {
		this.assertInitialized();
		const pending = this.writeTail.then(operation);
		this.writeTail = pending.then(() => undefined, () => undefined);
		return pending;
	}

	private async persist(state: PersistedState = this.state): Promise<void> {
		const temporaryPath = `${this.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporaryPath, JSON.stringify(state), { encoding: "utf8", flag: "wx" });
		try {
			await rename(temporaryPath, this.metadataPath);
		} catch (error) {
			const { unlink } = await import("node:fs/promises");
			await unlink(temporaryPath).catch(() => undefined);
			throw error;
		}
	}

	private appendEvent(
		task: StoredTask,
		type: AssistantEvent["type"],
		payload: AssistantEvent["payload"],
	): AssistantEvent {
		const event = makeEvent(task, type, payload);
		if (task.events.length > this.eventLimit) task.events.splice(0, task.events.length - this.eventLimit);
		return event;
	}

	private async recoverInterruptedTasks(): Promise<void> {
		let changed = false;
		for (const task of Object.values(this.state.tasks)) {
			if (taskIsTerminal(task.status)) continue;
			task.status = "interrupted";
			task.error = { code: "task_interrupted", message: "The service stopped before this task finished.", traceId: task.traceId };
			for (const message of task.messages) {
				if (message.status === "streaming") message.status = "interrupted";
			}
			for (const tool of task.tools) {
				if (tool.status === "running" || tool.status === "pending") tool.status = "interrupted";
			}
			this.appendEvent(task, "task.status", { status: "interrupted", error: task.error });
			const session = this.state.sessions[task.sessionId];
			if (session) {
				session.messages = session.messages.map((message) =>
					message.taskId === task.taskId && message.status === "streaming"
						? { ...message, status: "interrupted" }
						: message,
				);
				session.tools = session.tools.map((tool) =>
					tool.taskId === task.taskId && (tool.status === "running" || tool.status === "pending")
						? { ...tool, status: "interrupted" }
						: tool,
				);
				delete session.activeTaskId;
				session.updatedAt = new Date().toISOString();
			}
			changed = true;
		}
		if (changed) await this.persist();
	}

	async createSession(title?: string): Promise<SessionDetail> {
		return this.withWrite(async () => {
			const now = new Date().toISOString();
			const cleanTitle = title?.trim();
			const session: StoredSession = {
				sessionId: randomUUID(),
				title: cleanTitle || DEFAULT_TITLE,
				createdAt: now,
				updatedAt: now,
				messageCount: 0,
				messages: [],
				tools: [],
			};
			this.state.sessions[session.sessionId] = session;
			await this.persist();
			return this.sessionDetail(session);
		});
	}

	listSessions(): SessionSummary[] {
		this.assertInitialized();
		return Object.values(this.state.sessions)
			.map((session) => this.sessionSummary(session))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	getSession(sessionId: string): SessionDetail | undefined {
		this.assertInitialized();
		const session = this.state.sessions[sessionId];
		return session ? this.sessionDetail(session) : undefined;
	}

	getPiSessionFile(sessionId: string): string | undefined {
		this.assertInitialized();
		return this.state.sessions[sessionId]?.piSessionFile;
	}

	async renameSession(sessionId: string, title: string): Promise<SessionDetail> {
		return this.withWrite(async () => {
			const session = this.state.sessions[sessionId];
			if (!session) throw new HttpError(404, "session_not_found", "Session not found.");
			const cleanTitle = title.trim();
			if (!cleanTitle || cleanTitle.length > 100) {
				throw new HttpError(400, "invalid_title", "Session title must contain 1 to 100 characters.");
			}
			session.title = cleanTitle;
			session.updatedAt = new Date().toISOString();
			await this.persist();
			return this.sessionDetail(session);
		});
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		return this.withWrite(async () => {
			const session = this.state.sessions[sessionId];
			if (!session) return false;
			if (session.activeTaskId) {
				throw new HttpError(409, "active_task_conflict", "Stop the active task before deleting this session.");
			}
			const previousState = this.state;
			const nextState = structuredClone(previousState);
			delete nextState.sessions[sessionId];
			for (const [taskId, task] of Object.entries(nextState.tasks)) {
				if (task.sessionId === sessionId) delete nextState.tasks[taskId];
			}
			await this.persist(nextState);
			try {
				await this.removePiSessionFile(session.piSessionFile);
			} catch (error) {
				try {
					await this.persist(previousState);
				} catch (restoreError) {
					throw new AggregateError(
						[error, restoreError],
						"Session deletion failed and its metadata could not be restored.",
					);
				}
				throw error;
			}
			this.state = nextState;
			return true;
		});
	}

	private async removePiSessionFile(sessionFile: string | undefined): Promise<void> {
		if (!sessionFile) return;

		const sessionRoot = resolve(this.sessionDir);
		const candidate = resolve(sessionFile);
		if (!isAbsolute(sessionFile) || !inside(sessionRoot, candidate)) {
			throw new HttpError(500, "session_storage_error", "The session transcript could not be safely deleted.");
		}

		const dataRootReal = await realpath(this.dataDir);
		const sessionRootInfo = await lstat(sessionRoot);
		if (!sessionRootInfo.isDirectory() || sessionRootInfo.isSymbolicLink()) {
			throw new HttpError(500, "session_storage_error", "The session transcript could not be safely deleted.");
		}
		const sessionRootReal = await realpath(sessionRoot);
		if (!inside(dataRootReal, sessionRootReal)) {
			throw new HttpError(500, "session_storage_error", "The session transcript could not be safely deleted.");
		}

		let parentReal: string;
		try {
			parentReal = await realpath(dirname(candidate));
		} catch (error) {
			if (isFileNotFound(error)) return;
			throw error;
		}
		if (!insideOrEqual(sessionRootReal, parentReal)) {
			throw new HttpError(500, "session_storage_error", "The session transcript could not be safely deleted.");
		}

		let candidateInfo;
		try {
			candidateInfo = await lstat(candidate);
		} catch (error) {
			if (isFileNotFound(error)) return;
			throw error;
		}
		if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) {
			throw new HttpError(500, "session_storage_error", "The session transcript could not be safely deleted.");
		}
		const candidateReal = await realpath(candidate);
		if (!inside(sessionRootReal, candidateReal)) {
			throw new HttpError(500, "session_storage_error", "The session transcript could not be safely deleted.");
		}
		await unlink(candidate);
	}

	async startTask(input: StartTaskInput): Promise<StartTaskResult> {
		return this.withWrite(async () => {
			const session = this.state.sessions[input.sessionId];
			if (!session) throw new HttpError(404, "session_not_found", "Session not found.");
			if (input.clientRequestId) {
				const existing = Object.values(this.state.tasks).find((task) =>
					task.sessionId === input.sessionId && task.clientRequestId === input.clientRequestId,
				);
				if (existing) return { created: false, task: taskSnapshot(existing) };
			}
			if (session.activeTaskId) {
				throw new HttpError(409, "active_task_conflict", "This session already has an active task.");
			}

			const now = new Date().toISOString();
			const task: StoredTask = {
				sessionId: input.sessionId,
				taskId: input.taskId,
				traceId: input.traceId,
				status: "running",
				seq: 0,
				messages: [structuredClone(input.userMessage)],
				tools: [],
				events: [],
				cancelRequested: false,
				...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
			};
			this.state.tasks[task.taskId] = task;
			session.activeTaskId = task.taskId;
			session.messages.push(structuredClone(input.userMessage));
			session.messageCount = session.messages.length;
			if (session.title === DEFAULT_TITLE) session.title = titleFromText(input.userMessage.text);
			session.updatedAt = now;
			this.appendEvent(task, "task.status", { status: "running" });
			this.appendEvent(task, "message.upserted", { message: structuredClone(input.userMessage) });
			await this.persist();
			return { created: true, task: taskSnapshot(task) };
		});
	}

	getTask(taskId: string): TaskSnapshot | undefined {
		this.assertInitialized();
		const task = this.state.tasks[taskId];
		return task ? taskSnapshot(task) : undefined;
	}

	getTaskRecord(taskId: string): StoredTask | undefined {
		this.assertInitialized();
		const task = this.state.tasks[taskId];
		return task ? structuredClone(task) : undefined;
	}

	async updateTask(
		taskId: string,
		update: (task: StoredTask, session: StoredSession) => void,
	): Promise<TaskSnapshot> {
		return this.withWrite(async () => {
			const task = this.state.tasks[taskId];
			if (!task) throw new HttpError(404, "task_not_found", "Task not found.");
			const session = this.state.sessions[task.sessionId];
			if (!session) throw new HttpError(404, "session_not_found", "Session not found.");
			update(task, session);
			task.events = task.events.slice(-this.eventLimit);
			session.messageCount = session.messages.length;
			await this.persist();
			return taskSnapshot(task);
		});
	}

	async setPiSessionFile(sessionId: string, sessionFile: string | undefined): Promise<void> {
		return this.withWrite(async () => {
			const session = this.state.sessions[sessionId];
			if (!session) throw new HttpError(404, "session_not_found", "Session not found.");
			if (sessionFile) {
				const resolved = resolve(sessionFile);
				if (!isAbsolute(sessionFile) || !inside(this.sessionDir, resolved)) {
					throw new Error("Pi session path escaped the app-owned session directory");
				}
				session.piSessionFile = resolved;
			} else {
				delete session.piSessionFile;
			}
			await this.persist();
		});
	}

	getReplay(taskId: string, after: number): {
		snapshot: TaskSnapshot;
		events: AssistantEvent[];
		resync: "sequence_gap" | "replay_unavailable" | undefined;
	} {
		const task = this.getTaskRecord(taskId);
		if (!task) throw new HttpError(404, "task_not_found", "Task not found.");
		const oldest = task.events[0]?.seq ?? task.seq + 1;
		if (after > task.seq) {
			return { snapshot: taskSnapshot(task), events: [], resync: "sequence_gap" };
		}
		if (after < oldest - 1) {
			return { snapshot: taskSnapshot(task), events: [], resync: "replay_unavailable" };
		}
		return {
			snapshot: taskSnapshot(task),
			events: task.events.filter((event) => event.seq > after),
			resync: undefined,
		};
	}

	private sessionSummary(session: StoredSession): SessionSummary {
		return {
			sessionId: session.sessionId,
			title: session.title,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			messageCount: session.messages.length,
		};
	}

	private sessionDetail(session: StoredSession): SessionDetail {
		const { piSessionFile: _piSessionFile, ...detail } = session;
		return structuredClone(detail);
	}
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isPersistedState(value: unknown): value is PersistedState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<PersistedState>;
	return state.version === STATE_VERSION
		&& typeof state.sessions === "object" && state.sessions !== null
		&& typeof state.tasks === "object" && state.tasks !== null;
}
