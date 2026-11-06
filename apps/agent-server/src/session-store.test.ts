import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

	it("deletes the owned Pi transcript and tolerates an already-missing transcript", async () => {
		const store = await createStore();
		const session = await store.createSession("Transcript cleanup");
		const transcriptPath = join(store.sessionDir, "owned-session.jsonl");
		await writeFile(transcriptPath, "owned transcript");
		await store.setPiSessionFile(session.sessionId, transcriptPath);

		expect(await store.deleteSession(session.sessionId)).toBe(true);
		await expect(readFile(transcriptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		const missingTranscriptSession = await store.createSession("Missing transcript");
		await store.setPiSessionFile(missingTranscriptSession.sessionId, join(store.sessionDir, "already-missing.jsonl"));
		expect(await store.deleteSession(missingTranscriptSession.sessionId)).toBe(true);
	});

	it("refuses to delete a transcript path persisted outside the owned Pi session directory", async () => {
		const store = await createStore();
		const session = await store.createSession("Escaped transcript");
		const outsidePath = join(store.dataDir, "outside-session.jsonl");
		await writeFile(outsidePath, "preserve outside transcript");
		const metadataPath = join(store.dataDir, "metadata.json");
		const state = JSON.parse(await readFile(metadataPath, "utf8")) as {
			sessions: Record<string, { piSessionFile?: string }>;
		};
		state.sessions[session.sessionId]!.piSessionFile = outsidePath;
		await writeFile(metadataPath, JSON.stringify(state));

		const restarted = new SessionStore({ dataDir: store.dataDir });
		await restarted.init();
		await expect(restarted.deleteSession(session.sessionId)).rejects.toThrow();

		expect(await readFile(outsidePath, "utf8")).toBe("preserve outside transcript");
		expect(restarted.getSession(session.sessionId)?.sessionId).toBe(session.sessionId);
	});

	it("refuses to delete a transcript reached through a directory symlink escape", async () => {
		const store = await createStore();
		const session = await store.createSession("Symlink escape");
		const outsideDir = join(store.dataDir, "outside");
		await mkdir(outsideDir);
		const outsidePath = join(outsideDir, "linked-session.jsonl");
		await writeFile(outsidePath, "preserve symlink target");
		const linkPath = join(store.sessionDir, "redirect");
		await symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
		await store.setPiSessionFile(session.sessionId, join(linkPath, "linked-session.jsonl"));

		await expect(store.deleteSession(session.sessionId)).rejects.toThrow();
		expect(await readFile(outsidePath, "utf8")).toBe("preserve symlink target");
		expect(store.getSession(session.sessionId)?.sessionId).toBe(session.sessionId);
	});

	it("keeps transcript bytes and usable metadata when the metadata commit fails", async () => {
		const store = await createStore();
		const session = await store.createSession("Persistence rollback");
		const transcriptPath = join(store.sessionDir, "persist-failure.jsonl");
		await writeFile(transcriptPath, "keep this transcript");
		await store.setPiSessionFile(session.sessionId, transcriptPath);
		const storage = store as unknown as { persist: () => Promise<void> };
		storage.persist = async () => { throw new Error("simulated metadata write failure"); };

		await expect(store.deleteSession(session.sessionId)).rejects.toThrow("simulated metadata write failure");
		expect(await readFile(transcriptPath, "utf8")).toBe("keep this transcript");
		expect(store.getSession(session.sessionId)?.sessionId).toBe(session.sessionId);

		const restarted = new SessionStore({ dataDir: store.dataDir });
		await restarted.init();
		expect(restarted.getSession(session.sessionId)?.sessionId).toBe(session.sessionId);
	});

	it("restores persisted metadata when transcript removal fails", async () => {
		const store = await createStore();
		const session = await store.createSession("Removal rollback");
		const transcriptPath = join(store.sessionDir, "unlink-failure.jsonl");
		await writeFile(transcriptPath, "keep after unlink failure");
		await store.setPiSessionFile(session.sessionId, transcriptPath);
		const metadataPath = join(store.dataDir, "metadata.json");
		const deletion = store as unknown as { removePiSessionFile: (path: string | undefined) => Promise<void> };
		deletion.removePiSessionFile = async () => {
			const pending = JSON.parse(await readFile(metadataPath, "utf8")) as { sessions: Record<string, unknown> };
			if (pending.sessions[session.sessionId] !== undefined) {
				throw new Error("metadata deletion was not committed before transcript removal");
			}
			throw new Error("simulated transcript removal failure");
		};

		await expect(store.deleteSession(session.sessionId)).rejects.toThrow("simulated transcript removal failure");
		expect(await readFile(transcriptPath, "utf8")).toBe("keep after unlink failure");
		expect(store.getSession(session.sessionId)?.sessionId).toBe(session.sessionId);

		const restarted = new SessionStore({ dataDir: store.dataDir });
		await restarted.init();
		expect(restarted.getSession(session.sessionId)?.sessionId).toBe(session.sessionId);
	});
});
