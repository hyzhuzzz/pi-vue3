import { mkdtemp, rm } from "node:fs/promises";
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

async function appFor(configured: boolean) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-app-"));
	roots.push(root);
	return buildApp({ config: config(join(root, "data"), configured), runtime });
}

const local = { host: "127.0.0.1:3001" };

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("assistant API", () => {
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
});
