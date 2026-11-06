import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
	ASSISTANT_API_PREFIX,
	isTerminalTaskStatus,
	type AssistantEvent,
	type AssistantStreamEvent,
	type CreateTaskRequest,
	type HealthResponse,
	type JsonObject,
	type JsonValue,
	type SessionDetail,
} from "@pi-vue3/protocol";
import { createConfig, type AssistantConfig } from "./config.js";
import { apiError, HttpError } from "./errors.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { SessionStore } from "./session-store.js";
import { SseWriter } from "./sse-writer.js";
import { TaskManager } from "./task-manager.js";
import type { AgentRuntime } from "./runtime-types.js";

const MAX_TEXT_LENGTH = 40_000;
const MAX_CONTEXT_LENGTH = 24_000;
const HEARTBEAT_MS = 15_000;

export interface BuildAppOptions {
	config?: AssistantConfig;
	runtime?: AgentRuntime;
	skillRoot?: string;
	logger?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
	if (depth > 16) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
	if (isRecord(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
	return false;
}

function jsonObject(value: unknown, label: string): JsonObject {
	if (!isRecord(value) || !Object.values(value).every((item) => isJsonValue(item))) {
		throw new HttpError(400, "invalid_request", `${label} must be a JSON object.`);
	}
	return value as JsonObject;
}

function bodyRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new HttpError(400, "invalid_request", "Request body must be a JSON object.");
	return value;
}

function parseTaskRequest(value: unknown): CreateTaskRequest {
	const body = bodyRecord(value);
	if (typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_TEXT_LENGTH) {
		throw new HttpError(400, "invalid_task", `Task text must contain 1 to ${MAX_TEXT_LENGTH} characters.`);
	}
	if (body.clientRequestId !== undefined && (
		typeof body.clientRequestId !== "string"
		|| !body.clientRequestId.trim()
		|| body.clientRequestId.length > 200
	)) {
		throw new HttpError(400, "invalid_request_id", "clientRequestId must contain 1 to 200 characters.");
	}
	let context: JsonObject | undefined;
	if (body.context !== undefined) {
		context = jsonObject(body.context, "context");
		if (JSON.stringify(context).length > MAX_CONTEXT_LENGTH) {
			throw new HttpError(400, "context_too_large", `Context must be at most ${MAX_CONTEXT_LENGTH} characters.`);
		}
	}
	return {
		text: body.text,
		...(typeof body.clientRequestId === "string" ? { clientRequestId: body.clientRequestId.trim() } : {}),
		...(context === undefined ? {} : { context }),
	};
}

function parseAfter(value: string | undefined): number {
	if (value === undefined || value === "") return 0;
	if (!/^\d+$/.test(value)) throw new HttpError(400, "invalid_cursor", "after must be a non-negative integer.");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new HttpError(400, "invalid_cursor", "after must be a non-negative integer.");
	return parsed;
}

function isLocalHostname(hostname: string): boolean {
	const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return clean === "localhost" || clean === "127.0.0.1" || clean === "::1";
}

function localHostnameFromHost(hostHeader: string | undefined): string | undefined {
	if (!hostHeader || /[@/\\\s]/.test(hostHeader)) return undefined;
	try {
		const parsed = new URL(`http://${hostHeader}`);
		if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
		return parsed.hostname;
	} catch {
		return undefined;
	}
}

function assertLocalRequest(request: FastifyRequest): void {
	const hostName = localHostnameFromHost(request.headers.host);
	if (!hostName || !isLocalHostname(hostName)) {
		throw new HttpError(403, "local_only", "This service accepts requests only from a local host.");
	}
	const origin = request.headers.origin;
	if (origin !== undefined) {
		try {
			const parsed = new URL(origin);
			if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !isLocalHostname(parsed.hostname)) {
				throw new Error("non-local origin");
			}
		} catch {
			throw new HttpError(403, "local_only", "This service accepts requests only from a local origin.");
		}
	}
}

function sendError(reply: FastifyReply, error: HttpError, request: FastifyRequest): void {
	void reply.code(error.statusCode).send(apiError(error, request.id));
}

function terminalEvent(event: AssistantEvent): boolean {
	return event.type === "task.status" && isTerminalTaskStatus(event.payload.status);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
	const config = options.config ?? createConfig();
	const store = new SessionStore({ dataDir: config.dataDir });
	await store.init();
	const runtime = options.runtime ?? new PiAgentRuntime(config, store, options.skillRoot);
	const taskManager = new TaskManager(store, runtime);
	const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_CONTEXT_LENGTH + MAX_TEXT_LENGTH + 128_000 });

	app.addHook("onRequest", async (request) => assertLocalRequest(request));
	app.setErrorHandler((error, request, reply) => {
		if (error instanceof HttpError) {
			sendError(reply, error, request);
			return;
		}
		if (error instanceof Error && "statusCode" in error && (error as Error & { statusCode?: unknown }).statusCode === 400) {
			sendError(reply, new HttpError(400, "invalid_request", "Request body could not be parsed."), request);
			return;
		}
		sendError(reply, new HttpError(500, "internal_error", "The request could not be completed."), request);
	});
	app.addHook("onClose", async () => taskManager.shutdown());

	app.register(async (api) => {
		api.get("/health", async (): Promise<HealthResponse> => ({
			status: "ok",
			configured: config.model !== undefined,
			...(config.model ? { model: config.model.id } : {}),
		}));

		api.get("/sessions", async () => store.listSessions());
		api.post("/sessions", async (request, reply) => {
			let title: string | undefined;
			if (request.body !== undefined) {
				const body = bodyRecord(request.body);
				if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim().length > 100)) {
					throw new HttpError(400, "invalid_title", "Session title must contain at most 100 characters.");
				}
				if (typeof body.title === "string") title = body.title.trim();
			}
			const detail = await store.createSession(title);
			return reply.code(201).send(detail);
		});

		api.get<{ Params: { id: string } }>("/sessions/:id", async (request) => {
			const session = store.getSession(request.params.id);
			if (!session) throw new HttpError(404, "session_not_found", "Session not found.");
			return session;
		});

		api.patch<{ Params: { id: string } }>("/sessions/:id", async (request) => {
			const session = store.getSession(request.params.id);
			if (!session) throw new HttpError(404, "session_not_found", "Session not found.");
			const body = bodyRecord(request.body);
			if (typeof body.title !== "string") throw new HttpError(400, "invalid_title", "Session title is required.");
			return store.renameSession(request.params.id, body.title);
		});

		api.delete<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
			const deleted = await store.deleteSession(request.params.id);
			if (!deleted) throw new HttpError(404, "session_not_found", "Session not found.");
			return reply.code(204).send();
		});

		api.post<{ Params: { id: string } }>("/sessions/:id/tasks", async (request, reply) => {
			const session = store.getSession(request.params.id);
			if (!session) throw new HttpError(404, "session_not_found", "Session not found.");
			if (!config.model) throw new HttpError(503, "model_not_configured", "Configure the OpenAI compatible model before starting a task.");
			const parsed = parseTaskRequest(request.body);
			const snapshot = await taskManager.submit(request.params.id, parsed);
			return reply.code(202).send(snapshot);
		});

		api.get<{ Params: { id: string } }>("/tasks/:id", async (request) => taskManager.getTask(request.params.id));
		api.post<{ Params: { id: string } }>("/tasks/:id/cancel", async (request) => taskManager.cancel(request.params.id));

		api.get<{ Params: { id: string }; Querystring: { after?: string } }>("/tasks/:id/events", async (request, reply) => {
			const after = parseAfter(request.query.after);
			const pending: AssistantEvent[] = [];
			let ready = false;
			let closed = false;
			let lastSeq = after;
			let unsubscribe: () => void = () => {};
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			const raw = reply.raw;
			let writer: SseWriter;
			const stopProducing = () => {
				if (heartbeat) clearInterval(heartbeat);
				heartbeat = undefined;
				unsubscribe();
				request.raw.removeListener("close", onClientClose);
			};
			const endStream = () => {
				if (closed) return;
				closed = true;
				stopProducing();
				writer.end();
			};
			const onClientClose = () => {
				if (closed) return;
				closed = true;
				stopProducing();
				writer.destroy();
			};
			const deliver = (event: AssistantEvent) => {
				if (closed || event.seq <= lastSeq) return;
				if (event.seq !== lastSeq + 1) {
					const current = taskManager.getTask(event.taskId);
					const resync: AssistantStreamEvent = {
						type: "resync_required",
						sessionId: event.sessionId,
						taskId: event.taskId,
						traceId: event.traceId,
						reason: "sequence_gap",
						lastSeq,
						currentSeq: current.seq,
						occurredAt: new Date().toISOString(),
					};
					writer.writeEvent(resync);
					endStream();
					return;
				}
				if (!writer.writeEvent(event)) return;
				lastSeq = event.seq;
				if (terminalEvent(event)) endStream();
			};

			unsubscribe = taskManager.subscribe(request.params.id, (event) => {
				if (ready) deliver(event);
				else pending.push(event);
			});
			const replay = taskManager.replay(request.params.id, after);
			reply.hijack();
			raw.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			writer = new SseWriter(raw, () => {
				closed = true;
				stopProducing();
			});
			request.raw.on("close", onClientClose);

			if (replay.resync) {
				const resync: AssistantStreamEvent = {
					type: "resync_required",
					sessionId: replay.snapshot.sessionId,
					taskId: replay.snapshot.taskId,
					traceId: replay.snapshot.traceId,
					reason: replay.resync,
					lastSeq: after,
					currentSeq: replay.snapshot.seq,
					occurredAt: new Date().toISOString(),
				};
				writer.writeEvent(resync);
				endStream();
				return;
			}
			for (const event of replay.events) deliver(event);
			ready = true;
			pending.sort((a, b) => a.seq - b.seq);
			for (const event of pending) deliver(event);
			if (closed) return;
			if (isTerminalTaskStatus(replay.snapshot.status)) {
				endStream();
				return;
			}
			heartbeat = setInterval(() => {
				if (!closed) writer.writeHeartbeat();
			}, HEARTBEAT_MS);
			heartbeat.unref?.();
		});
	}, { prefix: ASSISTANT_API_PREFIX });

	return app;
}
