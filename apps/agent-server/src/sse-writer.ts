import { EventEmitter } from "node:events";
import type { AssistantStreamEvent } from "@pi-vue3/protocol";

export interface SseWritable extends EventEmitter {
	write(chunk: string): boolean;
	end(): unknown;
	destroy(error?: Error): unknown;
	readonly destroyed: boolean;
	readonly writableEnded: boolean;
}

export interface SseWriterOptions {
	maxQueuedFrames?: number;
	maxQueuedBytes?: number;
}

interface QueuedFrame {
	text: string;
	bytes: number;
}

const DEFAULT_MAX_QUEUED_FRAMES = 128;
const DEFAULT_MAX_QUEUED_BYTES = 512 * 1024;

function encodeEvent(event: AssistantStreamEvent): string {
	const id = "seq" in event ? `id: ${event.seq}\n` : "";
	return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class SseWriter {
	private readonly queue: QueuedFrame[] = [];
	private readonly maxQueuedFrames: number;
	private readonly maxQueuedBytes: number;
	private queuedBytes = 0;
	private blocked = false;
	private ending = false;
	private closed = false;

	private readonly onDrain = () => this.flushQueue();
	private readonly onResponseClose = () => this.dispose();
	private readonly onResponseFinish = () => this.dispose();

	constructor(
		private readonly response: SseWritable,
		private readonly onClose: () => void,
		options: SseWriterOptions = {},
	) {
		this.maxQueuedFrames = Math.max(1, options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES);
		this.maxQueuedBytes = Math.max(1, options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES);
		response.on("drain", this.onDrain);
		response.on("close", this.onResponseClose);
		response.on("finish", this.onResponseFinish);
	}

	writeEvent(event: AssistantStreamEvent): boolean {
		return this.writeFrame(encodeEvent(event));
	}

	writeHeartbeat(): void {
		if (!this.blocked) this.writeFrame(": heartbeat\n\n");
	}

	end(): void {
		if (this.closed || this.ending) return;
		this.ending = true;
		if (this.queue.length === 0) this.finish();
	}

	destroy(): void {
		if (this.closed) return;
		this.dispose();
		if (!this.response.destroyed && !this.response.writableEnded) this.response.destroy();
	}

	private writeFrame(text: string): boolean {
		if (this.closed || this.ending || this.response.destroyed || this.response.writableEnded) return false;
		if (Buffer.byteLength(text) > this.maxQueuedBytes) {
			this.destroy();
			return false;
		}
		if (this.blocked) return this.enqueue(text);
		try {
			if (!this.response.write(text)) this.blocked = true;
			return true;
		} catch {
			this.destroy();
			return false;
		}
	}

	private enqueue(text: string): boolean {
		const bytes = Buffer.byteLength(text);
		if (this.queue.length >= this.maxQueuedFrames || this.queuedBytes + bytes > this.maxQueuedBytes) {
			this.destroy();
			return false;
		}
		this.queue.push({ text, bytes });
		this.queuedBytes += bytes;
		return true;
	}

	private flushQueue(): void {
		if (this.closed || this.response.destroyed) {
			this.dispose();
			return;
		}
		this.blocked = false;
		while (this.queue.length > 0 && !this.blocked) {
			const frame = this.queue.shift()!;
			this.queuedBytes -= frame.bytes;
			try {
				if (!this.response.write(frame.text)) this.blocked = true;
			} catch {
				this.destroy();
				return;
			}
		}
		if (this.ending && this.queue.length === 0) this.finish();
	}

	private finish(): void {
		if (this.closed) return;
		this.dispose();
		if (!this.response.destroyed && !this.response.writableEnded) this.response.end();
	}

	private dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.queue.length = 0;
		this.queuedBytes = 0;
		this.response.removeListener("drain", this.onDrain);
		this.response.removeListener("close", this.onResponseClose);
		this.response.removeListener("finish", this.onResponseFinish);
		this.onClose();
	}
}
