import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";
import { TaskManager } from "./task-manager.js";
import type { AgentRuntime } from "./runtime-types.js";

const roots: string[] = [];

async function setup(runtime: AgentRuntime) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-task-"));
	roots.push(root);
	const store = new SessionStore({ dataDir: join(root, "data") });
	await store.init();
	const session = await store.createSession();
	return { store, manager: new TaskManager(store, runtime), session };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TaskManager", () => {
	it("deduplicates client retries and rejects a second active task in the same session", async () => {
		let starts = 0;
		const runtime: AgentRuntime = {
			run: async ({ signal }) => {
				starts += 1;
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		};
		const { manager, session } = await setup(runtime);
		const first = await manager.submit(session.sessionId, { text: "Check Vue", clientRequestId: "send-1" });
		const duplicate = await manager.submit(session.sessionId, { text: "Check Vue", clientRequestId: "send-1" });

		expect(duplicate.taskId).toBe(first.taskId);
		await expect(manager.submit(session.sessionId, { text: "Again", clientRequestId: "send-2" })).rejects.toMatchObject({
			code: "active_task_conflict",
		});
		expect(starts).toBe(1);
		await manager.cancel(first.taskId);
	});

	it("replays a fast completed task from sequence one without gaps", async () => {
		const runtime: AgentRuntime = {
			run: async ({ callbacks: { onMessageStart, onTextDelta, onMessageEnd } }) => {
				const id = await onMessageStart();
				await onTextDelta(id, "Ready");
				await onMessageEnd(id);
			},
		};
		const { manager, session } = await setup(runtime);
		const snapshot = await manager.submit(session.sessionId, { text: "Status?" });
		await manager.waitForTask(snapshot.taskId);
		const replay = await manager.replay(snapshot.taskId, 0);

		expect(replay.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(replay.events.map((event) => event.type)).toEqual([
			"task.status",
			"message.upserted",
			"message.upserted",
			"message.delta",
			"message.upserted",
			"task.status",
		]);
		expect(replay.snapshot.status).toBe("completed");
	});

	it("lets cancellation win a completion race once it has been accepted", async () => {
		let release!: () => void;
		let signalRuntimeStarted!: () => void;
		const runtimeStarted = new Promise<void>((resolve) => { signalRuntimeStarted = resolve; });
		const runtime: AgentRuntime = {
			run: async ({ callbacks: { onMessageStart, onTextDelta } }) => {
				const id = await onMessageStart();
				await onTextDelta(id, "Partial");
				await new Promise<void>((resolve) => {
					release = resolve;
					signalRuntimeStarted();
				});
			},
		};
		const { manager, session } = await setup(runtime);
		const task = await manager.submit(session.sessionId, { text: "Wait" });
		await runtimeStarted;
		const cancelPromise = manager.cancel(task.taskId);
		release();
		const [cancelled, repeated] = await Promise.all([cancelPromise, manager.cancel(task.taskId)]);
		const replay = await manager.replay(task.taskId, 0);

		expect(cancelled.status).toBe("cancelled");
		expect(repeated.status).toBe("cancelled");
		expect(replay.events.filter((event) => event.type === "task.status" && event.payload.status === "cancelled")).toHaveLength(1);
		expect(cancelled.messages.find((message) => message.text === "Partial")?.status).toBe("cancelled");
	});

	it("records an in-flight tool as cancelled when its abort result arrives", async () => {
		let signalToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => { signalToolStarted = resolve; });
		const runtime: AgentRuntime = {
			run: async ({ callbacks, signal }) => {
				await callbacks.onToolStart("call-1", "get_demo_items", { delayMs: 1_000 });
				signalToolStarted();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				await callbacks.onToolEnd("call-1", { content: [{ type: "text", text: "cancelled" }] }, true);
			},
		};
		const { manager, session } = await setup(runtime);
		const task = await manager.submit(session.sessionId, { text: "Wait for the tool" });
		await toolStarted;
		const cancelled = await manager.cancel(task.taskId);

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.tools).toEqual([expect.objectContaining({ id: "call-1", status: "cancelled" })]);
	});
});
