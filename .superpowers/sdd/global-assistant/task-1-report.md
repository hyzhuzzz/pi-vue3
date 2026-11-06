# Task 1: Workspace and shared protocol

## Delivered

- Added the pnpm workspace for `apps/*` and `packages/*`, shared TypeScript settings, and root `dev`, `build`, `typecheck`, and `test` scripts. Root scripts build shared packages first; app scripts run only when present, with app `dev` scripts launched in parallel. The runtime floor is Node `>=22.19.0`; the workspace pins pnpm `10.30.3`.
- Added `@pi-vue3/protocol`. Its package exports generated ESM and declaration files from `dist`; root `dev`, `build`, `typecheck`, and `test` build the protocol before consuming apps.
- Added no app manifests because those packages are still being scaffolded.

## Frozen protocol contracts

- `ASSISTANT_API_PREFIX` is the constant `'/api/assistant'`.
- `TaskStatus` is `'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'`. `TerminalTaskStatus` excludes `queued` and `running`; `isTerminalTaskStatus(status)` recognizes `completed`, `failed`, `cancelled`, and `interrupted`.
- `SessionSummary` fields: `sessionId`, `title`, `createdAt`, `updatedAt`, `messageCount`. `SessionDetail` extends it with `messages`, `tools`, and optional `activeTaskId`.
- `ChatMessage` fields: `id`, optional `taskId`, `role` (`user | assistant`), `text`, `status` (`streaming | completed | failed | cancelled | interrupted`), `createdAt`.
- `ToolCall` fields: `id`, optional `taskId`, `name`, JSON-object `arguments`, optional JSON `result`, `status` (`pending | running | completed | failed | cancelled | interrupted`), `createdAt`, optional `startedAt` and `completedAt`.
- `TaskSnapshot` fields: `sessionId`, `taskId`, `traceId`, `status`, per-task monotonic `seq` (starting at 1), `messages`, `tools`, optional `error`.
- `ApiError` uses the JSON envelope `{ "error": { "code", "message", "details?", "traceId?" } }`. A task snapshot's optional error uses the inner detail object.
- `CreateTaskRequest` is `{ text: string; clientRequestId?: string; context?: JsonObject }`.
- `HealthResponse` is `{ status: 'ok'; configured: boolean; model?: string }`; it has no provider key field.
- Persisted `AssistantEvent` variants share `type`, `sessionId`, `taskId`, `traceId`, `seq`, `occurredAt`, and `payload`: `task.status` carries `{ status, error? }`; `message.upserted` carries `{ message }`; `message.delta` carries `{ messageId, delta }`; `tool.upserted` carries `{ tool }`.
- `AssistantStreamEvent` also includes the out-of-band `ResyncRequiredEvent` discriminated by `type: 'resync_required'`, with `sessionId`, `taskId`, `traceId`, `reason` (`sequence_gap | replay_unavailable`), `lastSeq`, optional `currentSeq`, and `occurredAt`. It is not assigned a persisted event sequence; clients fetch a fresh task snapshot before resuming.
- `JsonValue`, `JsonObject`, `IsoDateTime`, `ApiErrorDetail`, and event-specific types are exported helpers for those DTOs.

## TDD and verification evidence

The terminal-status test was added before the predicate. With only the `TaskStatus` type present, `pnpm --filter @pi-vue3/protocol test` ran six cases and failed each at the missing predicate call (`isTerminalTaskStatus is not a function`). After implementing the predicate, the same command passed all 6 cases. The tests exercise status classification only; they do not mirror the type definitions.

Commands run:

| Command | Result |
| --- | --- |
| `pnpm install` | Passed; resolved TypeScript 5.9.3 and Vitest 3.2.7 and wrote `pnpm-lock.yaml`. pnpm reported ignored esbuild install scripts; Vitest ran successfully. |
| `pnpm --filter @pi-vue3/protocol typecheck` | Passed. |
| `pnpm build` | Passed; emitted protocol ESM and declarations. |
| `pnpm typecheck` | Passed. |
| `pnpm test` | Passed; all 6 protocol cases passed. |
| `pnpm dev` | Passed; built protocol and skipped app scripts because `apps/*` has no manifests yet. |
