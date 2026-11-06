# Global Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver and upload a Vue3 global assistant using real Pi SDK and configurable OpenAI-compatible models.

**Architecture:** Vue3 consumes product REST/SSE contracts from a standalone Node service. Pi owns agent execution and persisted model history; the service owns task identity, event replay and presentation snapshots. Business MCP/Skills and Java governance are added later.

**Tech Stack:** TypeScript, pnpm workspace, Vue3/Vite/Element Plus, Node >=22.19.0, Pi SDK, Fastify, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-global-assistant-design.md` (approved by user on 2026-11-06 with authorization to begin and MiMo test configuration).

## Global Constraints

- Explicit tools and Skill directory only; no personal Pi resources or coding tools.
- Secrets only in ignored server configuration; never commit credentials or return them to browser.
- OpenAI Chat Completions; test model `mimo-v2.6-flash`, base URL `https://api.xiaomimimo.com/v1`.
- Single local trusted user, loopback default; no usage-management module or production multiuser claim.
- Same-session one active task; one terminal event; disconnect does not cancel; history persists.
- All concrete execution agents use `gpt-6-luna`, reasoning `max`, per user preference; coordinator guides and verifies.

## Review Focus

- Submit/subscribe race and short fast completions: replay must include earlier output (Task 2).
- Cancel during tool and subsequent same-session prompt: no late mutation, usable context (Task 2).
- Cross-session deltas during switching/reconnect: no wrong-conversation content (Task 3).
- Missing model configuration and missing usage: actionable state without invented numbers (Tasks 2/3).
- Hostile Markdown, file paths and cross-origin JSON writes: no script, disk escape or unintended request (Tasks 2/3).

## Task 1: Workspace and shared protocol

**Files:** root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`; `packages/protocol/{package.json,tsconfig.json,src/index.ts,src/index.test.ts}`; empty app manifests permitted for install. Own these paths only.

**Interfaces:** Package `@pi-vue3/protocol`. Export `SessionSummary`, `SessionDetail`, `ChatMessage`, `ToolCall`, `TaskSnapshot`, `AssistantEvent`, `HealthResponse`, `TaskStatus`, `ApiError`, `CreateTaskRequest` and terminal predicate. API prefix `/api/assistant`. Task snapshot has sessionId, taskId, traceId, status, seq, messages, tools, optional error. Message has id, role user/assistant, text, status, createdAt; tools have id/name/arguments/result/status/timestamps. Session detail has messages/tools and optional activeTaskId; exact fields freeze in Task 1 and later tasks consume those definitions.

- [ ] Define discriminated event types and tests for terminal status classification.
- [ ] Verify failing test before adding predicate, implement, rerun.
- [ ] Root scripts `dev`, `build`, `typecheck`, `test`; pnpm packages under apps/* and packages/*; scripts skip absent app scripts while scaffolding.
- [ ] Install dependencies, run protocol tests/typecheck, report exported final interfaces and commit scoped files.

## Task 2: Pi service with persistent sessions and REST/SSE

**Files:** `apps/agent-server/package.json`, `tsconfig.json`, `src/{config,server,app,session-store,task-manager,pi-runtime,tools,skills}.ts`, focused tests alongside source; `skills/assistant-basics/SKILL.md`; `.env.example`. Subdivide large files by responsibility when needed.

**Interfaces:** Consume shared protocol. `buildApp(options)` returns testable Fastify app; `TaskManager` consumes injectable agent runtime for deterministic lifecycle tests; actual runtime uses Pi SDK, not a separately written agent loop. App default port 3001/host 127.0.0.1.

- [ ] Add tests (RED) for session CRUD/restart, duplicate submission and one-active-task conflict, fast replay, cancel races, unknown task/session, missing config, Origin/Host rejection, Skill path escape.
- [ ] Implement local metadata with atomic replacement and Pi SessionManager persistence, interrupted-on-restart behavior; keep transcript/tool relationships usable after failure/cancel.
- [ ] Register example tool `get_demo_items` (query and optional bounded delayMs; deterministic demo entries, abortable), and `read_skill` constrained to allowed Skill directory. Example Skill instructs use of demo tool for framework capability checks. No arbitrary file/bash/network tools. No personal resource discovery.
- [ ] Implement model configuration from `.env`: OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_API_KEY, OPENAI_CONTEXT_WINDOW, OPENAI_MAX_TOKENS, DATA_DIR, PORT. Support optional OPENAI_THINKING=disabled for MiMo through payload customization, keeping provider compatibility isolated. Configured model uses Pi `openai-completions`; verify actual installed types.
- [ ] Endpoints under prefix: GET health; GET/POST sessions; GET/PATCH/DELETE sessions/:id; POST sessions/:id/tasks with `{text,clientRequestId,context?}`; GET tasks/:id; GET tasks/:id/events?after=N; POST tasks/:id/cancel. Runtime error bodies sanitized; keep key out of response/history/log.
- [ ] SSE envelope matches protocol. Attach before prompt, bounded replay, seq dedupe, authoritative snapshots and resync event when cursor expired. Heartbeat and cleanup. Completed/error/cancelled/interrupted exactly once.
- [ ] Run focused tests, build/typecheck; report API examples, Pi version and real-provider assumptions; commit only owned files.

## Task 3: Vue global assistant and demo host

**Files:** `apps/web/{package.json,tsconfig.json,index.html,vite.config.ts,src/**}`; own web only.

**Interfaces:** Consume exact protocol and Task 2 REST routes. `AssistantProvider` or `AssistantPanel` mounts once at host root, accepts baseUrl and optional pageContext; global launcher opens drawer and expansion mode. Use fetch streaming, no secret in UI. Vite proxies API to 127.0.0.1:3001.

- [ ] Write RED reducer/SSE parser tests for fragmented UTF-8/framing, duplicate seq, snapshot replacement and inactive task/session event gating.
- [ ] Implement fetch client, session/task state, bounded reconnect with snapshot resync, abort cleanup on component unmount; task continues when closing UI. Stop uses POST cancel.
- [ ] Implement polished Chinese demo host and assistant with session list, new/rename/delete, Markdown/code rendering sanitized, textarea, send/stop, tool argument/result summaries, visible error and config states. Host should demonstrate global access across simple demo routes/tabs. Use coherent neutral palette and responsive sizing, no fake business data claimed real.
- [ ] Preserve local input while changing drawer mode; restore history; clientRequestId stable per submission and new on intentional retry; disable send when current session active.
- [ ] Run tests/typecheck/build, report integration assumptions, commit scoped files.

## Task 4: Integration, real MiMo validation and delivery

**Files:** root scripts/config as needed, `README.md`, `docs/deployment.md`, `tests/**`, `.github/workflows/ci.yml`, lockfile; integration fixes by original implementer when practical.

**Interfaces:** root pnpm dev/build/test/typecheck commands; built server serves web dist for same-origin local deployment. Service and front independently buildable and reusable.

- [ ] Run root tests/typecheck/build. Browser test covers launcher, create session, send/stream, tool UI, stop, refresh/history, switch sessions, drawer expansion; deterministic endpoint covers error/cancel/races.
- [ ] Configure ignored local MiMo key and run real Pi SDK smoke against specified model: multi-turn text, tool call and continuation, Skill read, cancellation and recovery. Log sanitized outcomes only.
- [ ] Visually inspect desktop and narrow viewport; fix actual layout or interaction problems.
- [ ] Add usage/extension/start/build/deploy/test instructions, environment example and Windows/Linux notes. Include distinction between mock and real checks.
- [ ] Fresh final code review and fix real findings; rerun affected checks.
- [ ] Scan tracked files for credentials, commit and upload to user-authorized GitHub repo. Verify remote tree/commit. Do not print/store secret in committed report.

## Execution rulings

- User explicitly said to begin; this plan is an execution artifact, no additional approval loop.
- Unborn empty repository has no existing code or commits to protect. Use a dedicated `codex/global-assistant` branch in the given directory rather than creating an extra checkout; record this environment adaptation in ledger.
- Commit identity is a local automation identity if no user Git identity is configured; do not change global Git config.
- Task 1 finishes and passes scoped review before dependent work. With its protocol frozen, Tasks 2 and 3 can run in separate owned source directories; coordinator serializes dependency and Git mutation steps. Each module receives a scoped review before integrated validation. No worker spawns its own agents.
