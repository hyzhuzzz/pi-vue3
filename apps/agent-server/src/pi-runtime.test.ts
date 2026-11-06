import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantConfig } from "./config.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { SessionStore } from "./session-store.js";
import { TaskManager } from "./task-manager.js";
import type { AgentRuntimeCallbacks } from "./runtime-types.js";

const roots: string[] = [];
const servers: Server[] = [];

async function fixtureServer(): Promise<{
	url: string;
	requests: () => number;
	observeSessionFile: (observer: () => string | undefined) => void;
	sessionFileAtRequest: () => string | undefined;
}> {
	let count = 0;
	let sessionFileAtRequest: string | undefined;
	let sessionFileObserver: () => string | undefined = () => undefined;
	const server = createServer((_request, response) => {
		count += 1;
		sessionFileAtRequest ??= sessionFileObserver();
		response.writeHead(401, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: "invalid api key" } }));
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		requests: () => count,
		observeSessionFile: (observer) => { sessionFileObserver = observer; },
		sessionFileAtRequest: () => sessionFileAtRequest,
	};
}

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-runtime-"));
	roots.push(root);
	const skillRoot = join(root, "skills");
	await mkdir(join(skillRoot, "assistant-basics"), { recursive: true });
	await writeFile(join(skillRoot, "assistant-basics", "SKILL.md"), "Use demo tools when needed.");
	const dataDir = join(root, "data");
	const store = new SessionStore({ dataDir });
	await store.init();
	const endpoint = await fixtureServer();
	const config: AssistantConfig = {
		workspaceRoot: root,
		dataDir,
		host: "127.0.0.1",
		port: 3001,
		model: {
			baseUrl: endpoint.url,
			id: "test-model",
			apiKey: "secret-fixture-api-key",
			contextWindow: 16_384,
			maxTokens: 1_024,
		},
		thinkingDisabled: false,
	};
	return { config, endpoint, root, skillRoot, store };
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PiAgentRuntime", () => {
	it("marks an SDK provider error as failed without exposing the configured key", async () => {
		const { config, endpoint, skillRoot, store } = await createFixture();
		const session = await store.createSession();
		endpoint.observeSessionFile(() => store.getPiSessionFile(session.sessionId));
		const manager = new TaskManager(store, new PiAgentRuntime(config, store, skillRoot));
		const task = await manager.submit(session.sessionId, { text: "Reply with one word." });
		await manager.waitForTask(task.taskId);
		const snapshot = manager.getTask(task.taskId);

		expect(endpoint.requests()).toBeGreaterThan(0);
		expect(snapshot.status).toBe("failed");
		expect(snapshot.error?.code).toBe("assistant_runtime_error");
		expect(snapshot.messages.find((message) => message.role === "assistant")?.status).toBe("failed");
		expect(endpoint.sessionFileAtRequest()).toBeTruthy();
		expect(JSON.stringify(snapshot)).not.toContain("secret-fixture-api-key");
		const piSessionFile = store.getPiSessionFile(session.sessionId);
		expect(piSessionFile).toBeTruthy();
		const history = await readFile(piSessionFile!, "utf8");
		expect(history).not.toContain("secret-fixture-api-key");
	});

	it("opens an app-assigned session path before its JSONL file has been created", async () => {
		const { config, endpoint, skillRoot, store } = await createFixture();
		const session = await store.createSession();
		const reservedFile = join(store.sessionDir, "reserved-first-turn.jsonl");
		await store.setPiSessionFile(session.sessionId, reservedFile);
		expect(existsSync(reservedFile)).toBe(false);
		const manager = new TaskManager(store, new PiAgentRuntime(config, store, skillRoot));
		const task = await manager.submit(session.sessionId, { text: "Reply with one word." });
		await manager.waitForTask(task.taskId);

		expect(endpoint.requests()).toBeGreaterThan(0);
		await expect(stat(reservedFile)).resolves.toBeTruthy();
	});

	it("does not prompt the model when the task signal was already aborted during setup", async () => {
		const { config, endpoint, skillRoot, store } = await createFixture();
		const session = await store.createSession();
		const runtime = new PiAgentRuntime(config, store, skillRoot);
		const controller = new AbortController();
		controller.abort();
		const callbacks: AgentRuntimeCallbacks = {
			onMessageStart: async () => "message",
			onTextDelta: async () => undefined,
			onMessageEnd: async () => undefined,
			onToolStart: async () => undefined,
			onToolEnd: async () => undefined,
			onSessionFile: async () => undefined,
		};

		await expect(runtime.run({
			sessionId: session.sessionId,
			sessionFile: undefined,
			prompt: "Do not send this.",
			signal: controller.signal,
			callbacks,
		})).rejects.toThrow();
		expect(endpoint.requests()).toBe(0);
	});
});
