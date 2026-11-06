export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Decode SSE frames without assuming network chunks align to text or frame boundaries. */
export async function* readSseFrames(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;

  const processLine = (rawLine: string): SseFrame | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      if (data.length === 0) {
        id = undefined;
        event = undefined;
        return undefined;
      }
      const frame: SseFrame = { data: data.join('\n') };
      if (id !== undefined) frame.id = id;
      if (event !== undefined) frame.event = event;
      data = [];
      id = undefined;
      event = undefined;
      return frame;
    }
    if (line.startsWith(':')) return undefined;

    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'event') event = value;
    return undefined;
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = processLine(line);
        if (frame) yield frame;
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const frame = processLine(buffer);
      if (frame) yield frame;
    }
    if (data.length > 0) {
      const frame: SseFrame = { data: data.join('\n') };
      if (id !== undefined) frame.id = id;
      if (event !== undefined) frame.event = event;
      yield frame;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The transport may already have cancelled its stream.
    }
    reader.releaseLock();
  }
}
