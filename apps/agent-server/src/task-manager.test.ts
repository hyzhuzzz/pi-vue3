import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore, type StoredSession, type StoredTask } from "./session-store.js";
import { TaskManager } from "./task-manager.js";
import type { AgentRuntime } from "./runtime-types.js";
import type { TaskSnapshot } from "@pi-vue3/protocol";

const roots: string[] = [];

class GatedSessionStore extends SessionStore {
	private armed = false;
	private updateCount = 0;
	private signalPaused!: () => void;
	private signalSecondUpdate!: () => void;
	private releaseFirst!: () => void;
	readonly firstUpdatePaused = new Promise<void>((resolve) => { this.signalPaused = resolve; });
	readonly secondUpdateFinished = new Promise<void>((resolve) => { this.signalSecondUpdate = resolve; });
	private readonly firstUpdateReleased = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

	arm(): void { this.armed = true; }
	release(): void { this.releaseFirst(); }

	override async updateTask(
		taskId: string,
		update: (task: StoredTask, session: StoredSession) => void,
	): Promise<TaskSnapshot> {
		if (this.armed) {
			this.updateCount += 1;
			if (this.updateCount === 1) {
				this.signalPaused();
				await this.firstUpdateReleased;
			}
		}
		const snapshot = await super.updateTask(taskId, update);
		if (this.armed && this.updateCount === 2) this.signalSecondUpdate();
		return snapshot;
	}
}

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
			run: async ({ callbacks: { onMessageStart, onTextDelta, onMessageEnd, onToolStart, onToolEnd } }) => {
				const id = await onMessageStart();
				await onTextDelta(id, "Ready");
				await onToolStart("tool-1", "get_demo_items", { query: "Vue" });
				await onToolEnd("tool-1", { content: [{ type: "text", text: "Vue 3" }] }, false);
				await onMessageEnd(id);
			},
		};
		const { manager, session } = await setup(runtime);
		const snapshot = await manager.submit(session.sessionId, { text: "Status?" });
		await manager.waitForTask(snapshot.taskId);
		const replay = await manager.replay(snapshot.taskId, 0);

		expect(replay.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(replay.events.map((event) => event.type)).toEqual([
			"task.status",
			"message.upserted",
			"message.upserted",
			"message.delta",
			"tool.upserted",
			"tool.upserted",
			"message.upserted",
			"task.status",
		]);
		expect(replay.events[2]).toMatchObject({ type: "message.upserted", payload: { message: { text: "", status: "streaming" } } });
		expect(replay.events[4]).toMatchObject({ type: "tool.upserted", payload: { tool: { id: "tool-1", status: "running" } } });
		expect(replay.events[5]).toMatchObject({ type: "tool.upserted", payload: { tool: { id: "tool-1", status: "completed", result: { text: "Vue 3", details: {} } } } });
		expect(replay.events[6]).toMatchObject({ type: "message.upserted", payload: { message: { text: "Ready", status: "completed" } } });
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

	it("lets cancellation accepted before terminal persistence win a concurrent runtime failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-cancel-failure-"));
		roots.push(root);
		const store = new GatedSessionStore({ dataDir: join(root, "data") });
		await store.init();
		const session = await store.createSession();
		store.arm();
		const manager = new TaskManager(store, { run: async () => { throw new Error("provider failed"); } });
		const task = await manager.submit(session.sessionId, { text: "Cause a provider failure" });
		await store.firstUpdatePaused;
		const cancellation = manager.cancel(task.taskId);
		await store.secondUpdateFinished;
		store.release();
		const cancelled = await cancellation;
		const replay = await manager.replay(task.taskId, 0);

		expect(cancelled.status).toBe("cancelled");
		expect(replay.events.filter((event) => event.type === "task.status" && ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status))).toHaveLength(1);
		expect(replay.events.at(-1)).toMatchObject({ type: "task.status", payload: { status: "cancelled" } });
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
