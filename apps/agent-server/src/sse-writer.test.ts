import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { AssistantEvent } from "@pi-vue3/protocol";
import { SseWriter } from "./sse-writer.js";

class FakeWritable extends EventEmitter {
	readonly writes: string[] = [];
	destroyed = false;
	writableEnded = false;
	private blockNext = true;

	write(chunk: string): boolean {
		this.writes.push(chunk);
		if (this.blockNext) {
			this.blockNext = false;
			return false;
		}
		return true;
	}

	end(): this {
		this.writableEnded = true;
		this.emit("finish");
		return this;
	}

	destroy(): this {
		this.destroyed = true;
		this.emit("close");
		return this;
	}
}

const event = (seq: number): AssistantEvent => ({
	type: "task.status",
	sessionId: "session-1",
	taskId: "task-1",
	traceId: "trace-1",
	seq,
	occurredAt: "2026-11-06T00:00:00.000Z",
	payload: { status: "running" },
});

describe("SseWriter", () => {
	it("queues frames during backpressure, skips heartbeats, and ends after drain", () => {
		const stream = new FakeWritable();
		let closed = false;
		const writer = new SseWriter(stream, () => { closed = true; }, { maxQueuedFrames: 1, maxQueuedBytes: 10_000 });

		expect(writer.writeEvent(event(1))).toBe(true);
		expect(writer.writeEvent(event(2))).toBe(true);
		writer.writeHeartbeat();
		writer.end();
		expect(stream.writes).toHaveLength(1);
		expect(stream.writableEnded).toBe(false);

		stream.emit("drain");
		expect(stream.writes).toHaveLength(2);
		expect(stream.writes.join("")).toContain('"seq":2');
		expect(stream.writes.join("")).not.toContain("heartbeat");
		expect(stream.writableEnded).toBe(true);
		expect(closed).toBe(true);
	});

	it("destroys a slow response when its bounded outbound queue is full", () => {
		const stream = new FakeWritable();
		let closed = false;
		const writer = new SseWriter(stream, () => { closed = true; }, { maxQueuedFrames: 1, maxQueuedBytes: 10_000 });

		expect(writer.writeEvent(event(1))).toBe(true);
		expect(writer.writeEvent(event(2))).toBe(true);
		expect(writer.writeEvent(event(3))).toBe(false);
		expect(stream.destroyed).toBe(true);
		expect(closed).toBe(true);
	});

	it("rejects a single frame that exceeds the outbound byte bound", () => {
		const stream = new FakeWritable();
		const writer = new SseWriter(stream, () => undefined, { maxQueuedFrames: 2, maxQueuedBytes: 512 });
		const largeDelta: AssistantEvent = {
			type: "message.delta",
			sessionId: "session-1",
			taskId: "task-1",
			traceId: "trace-1",
			seq: 1,
			occurredAt: "2026-11-06T00:00:00.000Z",
			payload: { messageId: "message-1", delta: "x".repeat(1_000) },
		};

		expect(writer.writeEvent(largeDelta)).toBe(false);
		expect(stream.destroyed).toBe(true);
	});

	it("ends a response after its final frame was accepted despite backpressure", () => {
		const stream = new FakeWritable();
		const writer = new SseWriter(stream, () => undefined);
		expect(writer.writeEvent(event(1))).toBe(true);
		writer.end();
		expect(stream.writableEnded).toBe(true);
	});
});
