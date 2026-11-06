import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantConfig } from "./config.js";
import { buildApp } from "./app.js";
import type { AgentRuntime } from "./runtime-types.js";

const roots: string[] = [];

function config(dataDir: string, configured: boolean): AssistantConfig {
	return {
		workspaceRoot: dataDir,
		dataDir,
		host: "127.0.0.1",
		port: 3001,
		model: configured
			? { baseUrl: "https://api.example.test/v1", id: "model-x", apiKey: "secret-test-key", contextWindow: 262144, maxTokens: 4096 }
			: undefined,
		thinkingDisabled: false,
	};
}

const runtime: AgentRuntime = { run: async () => undefined };

async function appFor(configured: boolean, agentRuntime: AgentRuntime = runtime) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-app-"));
	roots.push(root);
	return buildApp({ config: config(join(root, "data"), configured), runtime: agentRuntime });
}

const local = { host: "127.0.0.1:3001" };

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("assistant API", () => {
	it("serves the built Vue app and assets without exposing workspace files or masking 404s", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-static-"));
		roots.push(root);
		const workspaceRoot = join(root, "workspace");
		const distRoot = join(workspaceRoot, "apps", "web", "dist");
		await mkdir(join(distRoot, "assets"), { recursive: true });
		await writeFile(join(distRoot, "index.html"), "<!doctype html><main id=\"app\">built Vue app</main>");
		await writeFile(join(distRoot, "assets", "app.js"), "window.appReady = true;");
		await writeFile(join(workspaceRoot, ".env"), "PRIVATE_WORKSPACE_SECRET");
		await mkdir(join(workspaceRoot, ".data"), { recursive: true });
		await writeFile(join(workspaceRoot, ".data", "session.jsonl"), "PRIVATE_SESSION_DATA");

		const app = await buildApp({ config: config(workspaceRoot, false), runtime });
		const home = await app.inject({ method: "GET", url: "/", headers: local });
		const asset = await app.inject({ method: "GET", url: "/assets/app.js", headers: local });
		const health = await app.inject({ method: "GET", url: "/api/assistant/health", headers: local });
		const missingApi = await app.inject({ method: "GET", url: "/api/assistant/not-a-route", headers: local });
		const missingAsset = await app.inject({ method: "GET", url: "/assets/not-found.js", headers: local });
		const envFile = await app.inject({ method: "GET", url: "/.env", headers: local });
		const dataFile = await app.inject({ method: "GET", url: "/.data/session.jsonl", headers: local });

		expect(home.statusCode).toBe(200);
		expect(home.headers["content-type"]).toContain("text/html");
		expect(home.body).toContain("built Vue app");
		expect(asset.statusCode).toBe(200);
		expect(asset.body).toBe("window.appReady = true;");
		expect(health.statusCode).toBe(200);
		expect(health.headers["content-type"]).toContain("application/json");
		expect(health.json()).toEqual({ status: "ok", configured: false });
		expect(missingApi.statusCode).toBe(404);
		expect(missingApi.headers["content-type"]).toContain("application/json");
		expect(missingApi.body).not.toContain("built Vue app");
		expect(missingAsset.statusCode).toBe(404);
		expect(missingAsset.body).not.toContain("built Vue app");
		expect(envFile.statusCode).toBe(404);
		expect(dataFile.statusCode).toBe(404);
	});

	it("reports missing model configuration without exposing provider credentials", async () => {
		const app = await appFor(false);
		const health = await app.inject({ method: "GET", url: "/api/assistant/health", headers: local });
		const sessions = await app.inject({ method: "GET", url: "/api/assistant/sessions", headers: local });
		const created = await app.inject({ method: "POST", url: "/api/assistant/sessions", headers: local, payload: {} });
		const task = await app.inject({ method: "POST", url: `/api/assistant/sessions/${created.json().sessionId}/tasks`, headers: local, payload: { text: "hello" } });

		expect(health.json()).toEqual({ status: "ok", configured: false });
		expect(sessions.statusCode).toBe(200);
		expect(task.statusCode).toBe(503);
		expect(JSON.stringify(health.json())).not.toContain("secret");
		expect(JSON.stringify(task.json())).not.toContain("secret-test-key");
	});

	it("rejects non-local Host and Origin values", async () => {
		const app = await appFor(false);
		const badHost = await app.inject({ method: "GET", url: "/api/assistant/health", headers: { host: "evil.example" } });
		const badOrigin = await app.inject({ method: "POST", url: "/api/assistant/sessions", headers: { ...local, origin: "https://evil.example" }, payload: {} });

		expect(badHost.statusCode).toBe(403);
		expect(badOrigin.statusCode).toBe(403);
	});

	it("uses direct session DTOs and returns not-found for unknown task and session ids", async () => {
		const app = await appFor(false);
		const created = await app.inject({ method: "POST", url: "/api/assistant/sessions", headers: local, payload: { title: "First" } });
		const detail = created.json();
		const summaries = await app.inject({ method: "GET", url: "/api/assistant/sessions", headers: local });
		const unknownSession = await app.inject({ method: "GET", url: "/api/assistant/sessions/unknown", headers: local });
		const unknownTask = await app.inject({ method: "GET", url: "/api/assistant/tasks/unknown", headers: local });

		expect(detail).toMatchObject({ title: "First", messages: [], tools: [] });
		expect(Array.isArray(summaries.json())).toBe(true);
		expect(summaries.json()[0].sessionId).toBe(detail.sessionId);
		expect(unknownSession.statusCode).toBe(404);
		expect(unknownTask.statusCode).toBe(404);
	});

	it("replays completed task frames as a closed SSE response", async () => {
		let signalFinished!: () => void;
		const finished = new Promise<void>((resolve) => { signalFinished = resolve; });
		const successfulRuntime: AgentRuntime = {
			run: async ({ callbacks }) => {
				const messageId = await callbacks.onMessageStart();
				await callbacks.onTextDelta(messageId, "Ready");
				await callbacks.onMessageEnd(messageId);
				signalFinished();
			},
		};
		const app = await appFor(true, successfulRuntime);
		const created = await app.inject({ method: "POST", url: "/api/assistant/sessions", headers: local, payload: {} });
		const taskResponse = await app.inject({
			method: "POST",
			url: `/api/assistant/sessions/${created.json().sessionId}/tasks`,
			headers: local,
			payload: { text: "Ready?" },
		});
		await finished;
		const task = taskResponse.json();
		const stream = await app.inject({ method: "GET", url: `/api/assistant/tasks/${task.taskId}/events?after=0`, headers: local });
		const frames = stream.body.split(/\r?\n\r?\n/).filter((frame) => frame.startsWith("id:"));
		const events = frames.map((frame) => JSON.parse(frame.split(/\r?\n/).find((line) => line.startsWith("data: "))!.slice(6)));

		expect(stream.headers["content-type"]).toContain("text/event-stream");
		expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(events.at(-1)).toMatchObject({ type: "task.status", payload: { status: "completed" } });
	});
});
