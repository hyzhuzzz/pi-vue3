export type TaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type TerminalTaskStatus = Exclude<TaskStatus, 'queued' | 'running'>;

/** JSON-compatible values accepted by the API and returned by tool calls. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object with JSON-compatible values. */
export type JsonObject = { [key: string]: JsonValue };

/** ISO 8601 timestamp string, normally UTC and ending in `Z`. */
export type IsoDateTime = string;

/** All API endpoints share this path prefix. */
export const ASSISTANT_API_PREFIX = '/api/assistant' as const;

/** Summary returned by session list endpoints. */
export interface SessionSummary {
  /** Stable session identifier. */
  sessionId: string;
  /** User-facing session title. */
  title: string;
  /** ISO 8601 creation timestamp. */
  createdAt: IsoDateTime;
  /** ISO 8601 timestamp of the latest session activity. */
  updatedAt: IsoDateTime;
  /** Number of messages currently stored in this session. */
  messageCount: number;
}

export type ChatMessageRole = 'user' | 'assistant';
export type ChatMessageStatus = 'streaming' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** A user or assistant message. Streaming assistant messages are updated in place. */
export interface ChatMessage {
  /** Stable identifier unique within the session. */
  id: string;
  /** Task that produced this message, when known for historical grouping. */
  taskId?: string;
  role: ChatMessageRole;
  text: string;
  status: ChatMessageStatus;
  /** ISO 8601 timestamp when this message was created. */
  createdAt: IsoDateTime;
}

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** A JSON-safe tool invocation and its eventual result. */
export interface ToolCall {
  /** Stable identifier unique within the task. */
  id: string;
  /** Task that produced this tool call, when returned in session history. */
  taskId?: string;
  name: string;
  /** JSON object passed as tool arguments. */
  arguments: JsonObject;
  /** JSON-safe result, present after completion when the tool returns one. */
  result?: JsonValue;
  status: ToolCallStatus;
  /** ISO 8601 timestamp when the invocation was recorded. */
  createdAt: IsoDateTime;
  /** ISO 8601 timestamp when execution began, when known. */
  startedAt?: IsoDateTime;
  /** ISO 8601 timestamp when execution ended, when known. */
  completedAt?: IsoDateTime;
}

/** Full session view returned by session detail endpoints. */
export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  tools: ToolCall[];
  /** Identifier of the currently active task, omitted when none is active. */
  activeTaskId?: string;
}

/** The error value inside the standard API error envelope. */
export interface ApiErrorDetail {
  /** Stable machine-readable code, suitable for client branching. */
  code: string;
  /** Human-readable explanation safe to show to the user. */
  message: string;
  /** Optional JSON-safe diagnostic context; must not contain credentials. */
  details?: JsonValue;
  /** Trace identifier for correlating logs across the request and task. */
  traceId?: string;
}

/** Standard JSON API error body: `{ "error": { "code", "message", ... } }`. */
export interface ApiError {
  error: ApiErrorDetail;
}

/** Point-in-time task state. `seq` is the latest persisted event sequence, starting at 1. */
export interface TaskSnapshot {
  sessionId: string;
  taskId: string;
  traceId: string;
  status: TaskStatus;
  /** Monotonically increasing per-task sequence number. */
  seq: number;
  messages: ChatMessage[];
  tools: ToolCall[];
  /** Same shape as the inner `error` value in an {@link ApiError} response. */
  error?: ApiErrorDetail;
}

/** Request body accepted when creating a task inside a session. */
export interface CreateTaskRequest {
  /** User's task text. */
  text: string;
  /** Optional client-generated idempotency identifier. */
  clientRequestId?: string;
  /** Optional JSON-safe context supplied by the caller. */
  context?: JsonObject;
}

/** Health response deliberately exposes configuration state, never provider secrets. */
export interface HealthResponse {
  status: 'ok';
  configured: boolean;
  /** Active provider model identifier, when configured and available. */
  model?: string;
}

/** Base metadata shared by persisted assistant task events. */
export interface AssistantEventBase<TType extends string, TPayload> {
  type: TType;
  sessionId: string;
  taskId: string;
  traceId: string;
  /** Monotonically increasing per-task sequence number. */
  seq: number;
  /** ISO 8601 event creation timestamp. */
  occurredAt: IsoDateTime;
  /** Event-specific payload; the `type` discriminant determines its shape. */
  payload: TPayload;
}

export type TaskStatusEvent = AssistantEventBase<
  'task.status',
  { status: TaskStatus; error?: ApiErrorDetail }
>;

export type MessageUpsertedEvent = AssistantEventBase<
  'message.upserted',
  { message: ChatMessage }
>;

export type MessageDeltaEvent = AssistantEventBase<
  'message.delta',
  { messageId: string; delta: string }
>;

export type ToolUpsertedEvent = AssistantEventBase<
  'tool.upserted',
  { tool: ToolCall }
>;

/** Persisted events delivered through the task event stream. */
export type AssistantEvent = TaskStatusEvent | MessageUpsertedEvent | MessageDeltaEvent | ToolUpsertedEvent;

/** Out-of-band SSE control message requesting that the client fetch a fresh snapshot. */
export interface ResyncRequiredEvent {
  type: 'resync_required';
  sessionId: string;
  taskId: string;
  traceId: string;
  /** Why the client cannot continue applying the persisted event stream. */
  reason: 'sequence_gap' | 'replay_unavailable';
  /** Last contiguous sequence applied by the client. */
  lastSeq: number;
  /** Current latest task sequence when the server knows it. */
  currentSeq?: number;
  /** ISO 8601 time when this control message was sent. */
  occurredAt: IsoDateTime;
}

/** Any SSE message sent by the assistant task stream. */
export type AssistantStreamEvent = AssistantEvent | ResyncRequiredEvent;

/** True for every task state that will not resume after a process restart. */
export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'interrupted';
}
