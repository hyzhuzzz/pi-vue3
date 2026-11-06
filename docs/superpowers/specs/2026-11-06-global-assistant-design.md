# Pi + Vue3 全局助手基础版设计

日期：2026-11-06（Asia/Shanghai）  
状态：待用户审阅；本文是设计，尚未开始产品代码实现。

## 1. 目标与背景

先交付一个可独立运行、具有 Vue3 界面的通用助手。用户能够真实调用 OpenAI 兼容模型，进行多轮对话、查看工具执行、停止任务和继续历史会话。后续按业务功能逐步加入 Skill 和 MCP，并将前端嵌入现有产品。

用户现有项目包含基于 LangChain4j 的 AI 管理能力。该项目的用量统计、模型管理及 Vue3 管理界面留到后续接入；其后端数据模型和统计逻辑届时评估复用程度。

用户指定最终仓库：https://github.com/hyzhuzzz/pi-vue3 。当前仓库为空。任务由主代理规划、指导、集成和验收；具体执行优先委派给 `gpt-6-luna`，推理强度 `max`。

## 2. 已确认约束与本次建议

已确认：Vue3 前端、Pi 运行内核、独立 Node.js 服务、先做通用基础能力、模型走 OpenAI API 协议、允许为初期测试增加必要后端、后续逐步增加业务 Skill/MCP。

以下为主代理建议，随本文一起审阅：

- 前后端统一 TypeScript，前端采用 Vue3、Vite 和 Element Plus；pnpm workspace 管理同仓库工程。
- 第一版将“OpenAI 协议”具体落实为 Chat Completions `/chat/completions`，配置的 base URL 为 API 根地址（通常以 `/v1` 结尾），避免重复拼接；Responses API 留到后续确有需要时适配。
- 第一版为本机、单进程、单可信使用者模式，服务默认仅监听 loopback；不建设独立账号系统。
- 基础版先用 Vue3 直连 Node。Java Gateway 在需要验证产品集成时补充，不作为启动基础版的前置依赖。
- 中文界面，演示宿主页面挂载全局助手入口；助手支持侧栏与展开模式，共用同一套聊天状态。

## 3. 方案比较

### A. Vue3 + Node.js Pi 服务（建议采用）

直接实现完整对话闭环，减少初期服务数量。定义产品层 REST/SSE 协议，未来 Java 可以鉴权和转发相同协议。代价是正式迁移时仍需一次 Java 集成验证。

### B. Vue3 + Spring Boot Gateway + Node.js Pi 服务

可以提前验证 Java 转发、登录态和 SSE 链路；需要现有产品鉴权与部署背景，当前这些信息尚未提供，且用户希望先完成助手基础能力。仅在验证需求出现时增加最小 Java 层。

### C. 整体 Fork Pi Web UI

参考项目实际采用 React 与 WebSocket JSON 协议，能获得更多现成工作台功能，但与轻量 Vue3 嵌入目标不符。仅借鉴其聊天状态、工具展示和会话交互，保留引用来源与 MIT 许可要求，不移植完整编程工作台或照搬其传输层。

## 4. 交付范围

包含：全局入口、聊天侧栏与展开模式、输入和发送、Markdown 与代码块、多轮回复、流式文本、停止生成、错误提示、新建/切换/重命名/删除会话、本地服务端持久化、通用工具状态和结果摘要。

模型配置通过服务端本地环境配置提供 `baseUrl`、`model`、`apiKey`、上下文窗口和输出上限等必要参数；前端只显示连接/配置状态，不传回密钥。没有密钥时仍能启动界面并显示待配置提示。

提供一个确定性只读示例工具和一个受控目录下的示例 Skill，验证“模型决定调用工具—工具执行—模型继续回答”的完整链路。这沿用上一轮已提出的基础验收范围；“后续增加 Skills”指真实业务 Skills，不推迟这一次最小资源加载验证。示例不绑定具体业务。不预设模拟工具天然等同于 MCP 验收。

后续范围：真实业务 MCP、业务 Skills、Java Gateway 与现有登录态、管理界面、Token 统计/额度/计费、真实多用户隔离、多实例共享存储、子代理产品功能、附件、语音和复杂结果工作台。

不作为基础版目标：终端、Git、任意文件操作、代码编辑器、在线 Skill 编辑器、MCP 安装市场和流程设计器。

## 5. 模块与扩展边界

工程划分为 `apps/web`、`apps/agent-server`、`packages/protocol` 及 `skills`。具体文件拆分由实施计划决定。

- **web**：助手组件、宿主演示、消息与工具展示、REST/SSE 客户端。通过服务地址配置和页面上下文输入嵌入产品，不依赖 Pi 原始事件或服务端 SDK。
- **agent-server**：HTTP 接口、任务状态、会话归属/索引、模型配置、Pi 适配、受控工具注册、Skill 资源加载及流式事件适配。
- **protocol**：产品层请求、快照、事件、错误码和 TypeScript 类型；不导出 Pi 私有类型。
- **Pi 适配**：封装 SDK 生命周期、事件订阅、取消与持久化。后续 MCP 客户端通过工具注册边界加入，不修改聊天 UI 的核心协议。

本次官方资料核验：SDK 包为 `@earendil-works/pi-coding-agent`，官方仓库为 `earendil-works/pi`；当前 main 的 package.json 为 1.5.0，Node engines 为 `>=22.19.0`。实施时以实际发布包的可用版本和类型定义复核并锁定依赖，不能把浮动 main 的实现直接当作已安装版本。当前本机 Node 为 22.19.0，pnpm 为 10.30.3。

官方 SDK 的 `SessionManager` 是最终模型上下文的权威来源，禁止通过直接改写 agent 内存消息恢复历史。订阅在 prompt 前建立，任务终态须等待 SDK 真正闲置（核对版本中的 prompt 完成/agent_settled 语义），不能把某一轮 agent_end 直接当作整项任务完成。

## 6. 会话、任务与工具生命周期

- `sessionId`：持续多轮对话的会话；与 Pi 内部会话标识建立映射，不允许客户端指定磁盘路径。
- `taskId`：一次用户提交触发的执行，可能包含多轮模型调用和多个工具。
- `messageId`：一条用户或助手消息；一项任务可以产生多条助手消息。
- `toolCallId`：一次工具调用；名称相同的调用仍分别显示。
- `traceId`：一次任务的链路标识；预留 `modelCallId` 和可选 usage 元数据供将来治理适配。

同一会话最多一个运行任务；重复发送期间返回明确的冲突状态，不默认排队。使用客户端提交标识防止重试重复创建任务；去重记录按服务端本地状态保存，具体保留期限由实施者确定并写入说明。不同会话可切换，运行中任务继续在服务端执行。

关闭助手或断开 SSE 不隐式取消任务；只有停止按钮调用取消接口。取消操作幂等，完成与取消竞态由服务端终态仲裁，任务只产生一个终态。工具应接受取消信号；无法中断的工具在结果返回后不得继续触发新的模型调用。

会话历史由服务端保存，Pi 的上下文由其持久化机制管理；产品元数据单独保存索引与任务状态，避免重复拼装模型上下文。历史消息中保留工具调用/结果关系。部分文本遇到取消或错误仍保留，并显示状态。服务重启时未结束任务标记为 interrupted，不自动重发模型请求；恢复会话时校验未闭合工具调用，确保下一次发送不产生无配对工具结果的协议错误。

第一版使用本地数据目录，纳入忽略规则。持久化写入按会话串行，元数据以临时文件替换等方式避免半写状态；数据损坏返回可理解错误，不静默丢弃其他会话。

## 7. HTTP 与流式事件

建议接口（统一前缀 `/api/assistant`）：

| 方法与路径 | 责任 |
| --- | --- |
| `GET /health` | 存活、配置就绪状态；不回显密钥 |
| `GET/POST /sessions` | 列表、新建 |
| `GET/PATCH/DELETE /sessions/:id` | 详情、重命名、删除；运行中会话禁止删除 |
| `POST /sessions/:id/tasks` | 接受消息和客户端提交标识，返回 taskId/traceId |
| `GET /tasks/:id` | 当前任务快照：状态、消息、工具及最新 seq |
| `GET /tasks/:id/events?after=...` | 使用 fetch 读取 SSE，可携带未来产品认证头 |
| `POST /tasks/:id/cancel` | 幂等停止任务 |

任务提交与事件订阅分离，服务端先建立任务记录和事件缓冲再启动 Pi，避免先产生回复后订阅而丢事件。每个任务事件包含 `version`、`seq`、`sessionId`、`taskId`、`traceId`、`timestamp`、`type`、`data`。

第一版事件：`task_started`、`message_started`、`message_delta`、`message_completed`、`tool_started`、`tool_completed`、`task_completed`、`task_failed`、`task_cancelled`、`task_interrupted`。工具失败在工具结果中有独立状态；可恢复工具错误由 Agent 继续处理，整个任务不一律判失败。

事件按任务递增 seq，客户端按 seq 去重。服务端保留有界内存缓冲，刷新或重连可回放。超出保留窗口返回明确的 resync 信号；客户端读取任务快照、按快照 seq 重新订阅，并替换而非叠加已有展示。快照生成和缓冲订阅的边界必须可证明无遗漏。重连只订阅任务，不重新提交用户消息。终态后关闭流，清理订阅；缓慢消费者、心跳及缓冲上限由实施者选取合理数值并验证。

浏览器刷新期间任务继续；Node 重启后通过持久化快照展示 interrupted，不要求跨进程重放每一个文本 delta。

## 8. 模型、Skill 与访问限制

首版接入可配置的 OpenAI Chat Completions 兼容端点，支持流式文本与 function tool calling。模型名称不硬编码；网关兼容性通过普通对话、流式输出和工具调用分别验证。usage 缺失不当作零消耗，不做费用估算和计费入库。

凭据仅存服务端环境配置，示例配置只有占位符；会话和日志不得保存密钥。默认不读取本机个人 Pi 配置、认证文件、全局 Skill、扩展和项目级可执行钩子。

禁用 Pi 默认编程工具；只显式注册示例业务无关工具和必要的受限 Skill 读取能力。Skill 仅发现仓库指定目录并按需读取内容，禁止通过路径遍历或符号链接越过允许根目录。保留 Pi 的 Skill 提示/发现语义，不把所有 Skill 文本无条件塞入系统提示词。

用户内容、Markdown 和工具结果按不可信内容渲染，不执行 HTML/脚本。浏览器输入不能覆盖系统提示、模型密钥、工具权限和 Skill 路径。

本地版默认同源代理或限定开发源，服务限制 Host/Origin，JSON 写接口拒绝意外跨源调用；不配置任意来源 CORS。对外部署须接入产品登录鉴权和会话归属校验，不能把单可信使用者模式当成生产多用户方案。

## 9. 验收与验证

1. 配置服务端 OpenAI 兼容端点后，真实多轮对话与流式回复可用；密钥从不出现在前端资源和浏览器响应中。
2. 示例工具可被模型自主调用，前端正确呈现调用、完成/失败与后续回答；示例 Skill 的发现与按需读取可观察验证。
3. 停止生成后保留已收到内容且能继续对话；工具中取消、请求超时和无效配置得到清晰反馈。
4. 新建、切换、重命名、删除与恢复会话可用；刷新不中断任务；服务重启保留历史并标记未完成任务。
5. 验证快速完成任务不丢事件、重连不重复文本、不重复提交、快照恢复和终态竞态。
6. 通过同一助手组件在宿主演示中全局打开和展开，业务宿主只需注入服务配置与可选页面上下文。
7. 类型检查、构建与关键生命周期/协议测试通过；提供启动说明、部署说明、示例配置、依赖锁文件和 GitHub 可审阅提交。

自动化协议及失败路径使用本地可控的 OpenAI 兼容测试服务，避免依赖真实 API 的随机响应。真实模型联调单独记录所用端点/模型（脱敏）、结果和未验证项。没有真实凭据时明确标记真实联调未完成，不以模拟结果替代该结论。

## 10. 实施顺序与留给实施者的选择

设计获确认后编写可执行开发计划：先锁定运行时/SDK并定义协议，再拆分前后端任务，完成集成和测试，最后上传指定 GitHub 仓库。接口先行，子代理按文件边界分工，主代理审查合并和验收。

HTTP 框架、Markdown 库、日志格式、内部文件拆分、合理缓冲/超时数值、组件细节和测试工具由实施者决定；需要改变以上范围或生命周期语义的选择返回设计讨论。

## 11. 一手参考资料

- OpenAI Chat Completions API：https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- OpenAI 流式事件：https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
- Pi SDK 官方文档：https://pi.dev/docs/latest/sdk
- Pi 官方包定义：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json
- Pi 官方 SDK 实现：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/sdk.ts
- Pi 官方 Skill 资源加载：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/resource-loader.ts
- 参考项目说明与许可：https://github.com/xing-shuyin/pi-web-ui/blob/main/README.md 、https://github.com/xing-shuyin/pi-web-ui/blob/main/LICENSE
- 参考项目聊天协议与客户端：https://github.com/xing-shuyin/pi-web-ui/blob/main/server/protocol.ts 、https://github.com/xing-shuyin/pi-web-ui/blob/main/web/src/use-chat.ts

## 12. 设计检查记录

已由独立 `gpt-6-luna` / `max` 子代理进行可实施性检查。唯一范围疑问是示例 Skill 是否推迟；依照上一轮基础范围提议，已明确基础版保留最小加载验证，真实业务 Skills 后续加入。SDK 核验与参考项目核验分别由两位同配置子代理执行，主代理核对了官方 SDK 文档及包定义；尚未安装 SDK 或验证真实模型。
