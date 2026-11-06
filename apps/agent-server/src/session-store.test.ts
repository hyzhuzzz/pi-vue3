import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";

const roots: string[] = [];

async function createStore() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-store-"));
	roots.push(root);
	const store = new SessionStore({ dataDir: join(root, "data") });
	await store.init();
	return store;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionStore", () => {
	it("persists CRUD and recovers an unfinished task as interrupted", async () => {
		const store = await createStore();
		const created = await store.createSession("Framework check");
		await store.renameSession(created.sessionId, "Framework check 2");
		await store.startTask({
			sessionId: created.sessionId,
			taskId: "task-1",
			traceId: "trace-1",
			clientRequestId: "request-1",
			userMessage: {
				id: "message-1",
				taskId: "task-1",
				role: "user",
				text: "Check Vue",
				status: "completed",
				createdAt: "2026-11-06T00:00:00.000Z",
			},
		});

		const restarted = new SessionStore({ dataDir: store.dataDir });
		await restarted.init();
		expect((await restarted.getSession(created.sessionId))?.title).toBe("Framework check 2");
		expect((await restarted.getSession(created.sessionId))?.activeTaskId).toBeUndefined();
		const recovered = await restarted.getTask("task-1");
		expect(recovered?.status).toBe("interrupted");
		expect(recovered?.seq).toBe(3);
		expect(recovered?.messages).toEqual([
			expect.objectContaining({ id: "message-1", text: "Check Vue", status: "completed" }),
		]);
		expect(await restarted.deleteSession(created.sessionId)).toBe(true);
		expect(await restarted.getSession(created.sessionId)).toBeUndefined();
	});

	it("returns the existing task for a repeated client request id before checking active-task conflict", async () => {
		const store = await createStore();
		const session = await store.createSession();
		const input = {
			sessionId: session.sessionId,
			taskId: "task-1",
			traceId: "trace-1",
			clientRequestId: "same-request",
			userMessage: {
				id: "message-1",
				taskId: "task-1",
				role: "user" as const,
				text: "one",
				status: "completed" as const,
				createdAt: "2026-11-06T00:00:00.000Z",
			},
		};
		const first = await store.startTask(input);
		const duplicate = await store.startTask({
			...input,
			taskId: "task-2",
			traceId: "trace-2",
			userMessage: { ...input.userMessage, id: "message-2", taskId: "task-2", text: "two" },
		});

		expect(duplicate.created).toBe(false);
		expect(duplicate.task.taskId).toBe(first.task.taskId);
		expect((await store.getSession(session.sessionId))?.messages).toHaveLength(1);
	});
});
