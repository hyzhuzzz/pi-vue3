# 架构与 API

```text
Vue3 宿主
  └─ AssistantShell + useAssistant
             │ REST / SSE
Node.js Agent Service
  ├─ HTTP 路由与任务生命周期
  ├─ SessionStore / 事件缓冲与快照
  └─ PiAgentRuntime
       ├─ Pi AgentSession / SessionManager
       ├─ OpenAI-compatible model
       └─ 显式注册的 Tools / 受控 Skills
```

`apps/web` 提供界面；`apps/agent-server` 运行真实 Agent；`packages/protocol` 定义共享 DTO。SDK 适配封装在 `pi-runtime.ts`，模型调用与工具循环由 Pi 执行。

## 身份与生命周期

- `sessionId`：多轮对话会话。
- `taskId`：一次用户提交，可能产生多次模型和工具调用。
- `ChatMessage.id` / `ToolCall.id`：消息与工具调用标识。
- `traceId`：任务关联标识。

同一会话最多有一个运行任务。客户端通过 `clientRequestId` 防止重试重复提交。关闭界面或断开 SSE 保留服务端任务；显式取消调用停止接口。

任务终态包括 `completed`、`failed`、`cancelled`、`interrupted`。终态由服务端决定，每项任务只有一次终态转换。

## REST

统一前缀：`/api/assistant`。成功响应直接返回 DTO。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /health` | 服务与模型配置状态 |
| `GET /sessions` | 会话列表 |
| `POST /sessions` | 新建，可传 `{ "title": "..." }` |
| `GET /sessions/:id` | 会话消息、工具与运行任务标识 |
| `PATCH /sessions/:id` | 修改标题 |
| `DELETE /sessions/:id` | 删除会话与对应 Pi 记录 |
| `POST /sessions/:id/tasks` | 提交 `{ text, clientRequestId?, context? }` |
| `GET /tasks/:id` | 完整任务快照 |
| `GET /tasks/:id/events?after=N` | 从序号 N 后订阅 SSE |
| `POST /tasks/:id/cancel` | 幂等取消 |

错误响应使用 `{ "error": { "code", "message", "traceId?" } }`。`health.configured` 表示服务端已提供模型参数，实际模型连通性通过任务或 `test:live` 验证。

## SSE

数据事件包括 `task.status`、`message.upserted`、`message.delta` 和 `tool.upserted`。它们携带会话、任务、trace、时间和递增 `seq`。字段以 [`protocol/src/index.ts`](../packages/protocol/src/index.ts) 为准。

服务端保留有限事件窗口，创建事件时保存独立数据快照。客户端按 `seq` 去重；回放窗口不足或序号不连续时接收 `resync_required`，读取任务快照后重新订阅。重新订阅不会重新提交问题。

SSE 写入处理背压，限制待发送队列，并清理断开的订阅。

## 持久化

应用元数据保存在 `DATA_DIR`，Pi 会话记录放在其 `pi-sessions` 子目录。Pi `SessionManager` 管理模型上下文，应用保存会话到 Pi 文件的关联关系。

服务重启后，运行中的任务变为 `interrupted`，不自动再次调用模型。下一轮从原 Pi 记录恢复上下文。删除会话同时清理经过目录边界检查的对应 Pi 文件。

文件格式由应用管理；当前不提供手工元数据编辑或数据库迁移工具。
