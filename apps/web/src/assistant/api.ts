import {
  ASSISTANT_API_PREFIX,
  type ApiError,
  type AssistantStreamEvent,
  type CreateTaskRequest,
  type HealthResponse,
  type SessionDetail,
  type SessionSummary,
  type TaskSnapshot,
} from '@pi-vue3/protocol';
import { readSseFrames } from './stream';

export class AssistantApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'AssistantApiError';
    this.code = code;
    this.status = status;
  }
}

export class AssistantApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string = ASSISTANT_API_PREFIX) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.request('/health', this.withSignal(signal));
  }

  async listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
    return this.request('/sessions', this.withSignal(signal));
  }

  async createSession(signal?: AbortSignal): Promise<SessionDetail> {
    return this.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      ...this.withSignal(signal),
    });
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`, this.withSignal(signal));
  }

  async renameSession(sessionId: string, title: string, signal?: AbortSignal): Promise<SessionDetail> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
      ...this.withSignal(signal),
    });
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(this.url(`/sessions/${encodeURIComponent(sessionId)}`), {
      method: 'DELETE',
      ...this.withSignal(signal),
    });
    if (!response.ok) throw await this.makeError(response);
  }

  async createTask(sessionId: string, request: CreateTaskRequest, signal?: AbortSignal): Promise<TaskSnapshot> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      ...this.withSignal(signal),
    });
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}`, this.withSignal(signal));
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      ...this.withSignal(signal),
    });
  }

  async *taskEvents(taskId: string, after: number, signal: AbortSignal): AsyncGenerator<AssistantStreamEvent> {
    const response = await fetch(this.url(`/tasks/${encodeURIComponent(taskId)}/events?after=${after}`), {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok) throw await this.makeError(response);
    if (!response.body) throw new AssistantApiError('事件流暂时不可用。', 'STREAM_UNAVAILABLE', response.status);

    for await (const frame of readSseFrames(response.body, signal)) {
      if (!frame.data) continue;
      try {
        yield JSON.parse(frame.data) as AssistantStreamEvent;
      } catch {
        throw new AssistantApiError('助手返回了无法读取的事件。', 'INVALID_STREAM_EVENT', response.status);
      }
    }
  }

  private url(path: string): string {
    return `${this.baseUrl || ASSISTANT_API_PREFIX}${path}`;
  }

  private withSignal(signal?: AbortSignal): RequestInit {
    return signal ? { signal } : {};
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.url(path), init);
    if (!response.ok) throw await this.makeError(response);
    return response.json() as Promise<T>;
  }

  private async makeError(response: Response): Promise<AssistantApiError> {
    let message = `请求失败（${response.status}）。`;
    let code = 'HTTP_ERROR';
    try {
      const payload = await response.json() as ApiError;
      if (payload.error?.message) message = payload.error.message;
      if (payload.error?.code) code = payload.error.code;
    } catch {
      // Keep the status-based message when the server does not return an API error envelope.
    }
    return new AssistantApiError(message, code, response.status);
  }
}
