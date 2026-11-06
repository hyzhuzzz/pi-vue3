import { describe, expect, it } from 'vitest';
import { readSseFrames } from './stream';

function byteStream(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });
}

describe('readSseFrames', () => {
  it('decodes split UTF-8 and fragmented CRLF SSE frames', async () => {
    const encoder = new TextEncoder();
    const payload = 'data: {"type":"message.delta","payload":{"delta":"你好"}}\r\n\r\n';
    const bytes = encoder.encode(payload);
    const chinese = encoder.encode('你');
    const splitAt = bytes.findIndex((value, index) => value === chinese[0] && bytes[index + 1] === chinese[1]);
    const chunks = [bytes.slice(0, splitAt + 1), bytes.slice(splitAt + 1, splitAt + 3), bytes.slice(splitAt + 3, -1), bytes.slice(-1)];

    const frames = [];
    for await (const frame of readSseFrames(byteStream(chunks))) frames.push(frame);

    expect(frames).toEqual([{ data: '{"type":"message.delta","payload":{"delta":"你好"}}' }]);
  });

  it('joins multiple data lines and ignores comments while retaining the event id', async () => {
    const stream = byteStream([new TextEncoder().encode(': heartbeat\nid: 12\nevent: assistant\ndata: first\ndata: second\n\n')]);
    const frames = [];
    for await (const frame of readSseFrames(stream)) frames.push(frame);

    expect(frames).toEqual([{ id: '12', event: 'assistant', data: 'first\nsecond' }]);
  });
});
