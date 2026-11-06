# Pi Vue3 Assistant

基于 Vue3 与 Pi SDK 的通用全局助手。前端可以独立演示，也可以作为组件嵌入现有 Vue3 产品；Node.js 服务负责模型调用、会话和任务执行。

## 运行环境

- Node.js >= 22.19.0
- pnpm 10.30.3（仓库通过 `packageManager` 固定）
- 支持流式响应与函数工具调用的 OpenAI Chat Completions 兼容端点

## 本地启动

```powershell
pnpm install
Copy-Item .env.example .env
# 编辑 .env，填写模型地址、模型名称和密钥
pnpm dev
```

开发页面默认位于 `http://127.0.0.1:5173`，助手服务位于 `http://127.0.0.1:3001`；前端开发服务器代理助手 API。

Linux/macOS 使用 `cp .env.example .env`。模型密钥由服务端读取，不能放进 `VITE_*` 变量或前端代码。

MiMo 的 OpenAI 兼容配置示例（密钥自行填写）：

```dotenv
OPENAI_BASE_URL=https://api.xiaomimimo.com/v1
OPENAI_MODEL=mimo-v2.6-flash
OPENAI_API_KEY=your-api-key
OPENAI_MAX_TOKENS=4096
OPENAI_THINKING=disabled
```

这里的 base URL 是 `/v1` 根地址，不是完整的 `/chat/completions` 路径。`OPENAI_THINKING` 是 MiMo 适配配置，其他兼容服务按其支持情况配置。

## 工程结构

```text
apps/web             Vue3 助手与宿主演示
apps/agent-server    Node.js Pi 服务
packages/protocol    前后端共享类型
skills               随版本维护的示例 Skill
docs                 设计、实施计划与部署说明
```

第一版提供流式对话、会话历史、工具状态、停止生成和示例 Skill/工具。示例工具只返回演示数据，用于验证扩展链路。真实业务 MCP、Java 登录鉴权、模型管理与用量统计随产品集成逐步加入。

![助手展开模式](docs/screenshots/assistant-expanded.png)

## 构建与检查

```sh
pnpm typecheck
pnpm test
pnpm build
```

浏览器交互测试使用可控测试接口：

```sh
pnpm test:e2e
```

Windows 默认使用已安装的 Edge。其他系统先运行 `pnpm exec playwright install chromium`。

服务启动并配置模型后，可单独运行真实模型接入检查：

```sh
pnpm test:live
```

该命令实际调用服务端配置的模型，验证文本、多轮上下文、Skill 读取和工具调用，并保留名为“模型接入自检”的会话。它不参与默认测试或 CI。

根脚本先构建共享协议，再处理应用。生产运行方式、数据目录和嵌入边界见 [部署说明](docs/deployment.md)。

## 协议与扩展

REST/SSE 统一使用 `/api/assistant` 前缀，传输对象在 `packages/protocol/src/index.ts` 定义。页面只依赖产品协议，不直接依赖 Pi SDK。

- `sessionId` 标识多轮会话，`taskId` 标识一次用户提交，`toolCallId`（工具 DTO 的 `id`）标识一次工具调用。
- 文本通过带序号的事件更新；重连只重新订阅，不重复提交问题。
- 关闭面板不停止任务；停止按钮显式请求取消。
- 同一会话只允许一个运行任务；服务重启后未结束任务显示为中断。
- 新工具通过服务端显式注册接入；Skill 只从受控目录加载。

前端管理界面和统计模块不属于这一版。将来接入现有 Spring Boot 产品时，可以保留前端组件和协议，由 Java 负责真实身份、会话归属、配置与治理。

## 参考

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [MiMo 首次调用 API](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Pi Web UI](https://github.com/xing-shuyin/pi-web-ui)：借鉴聊天事件和会话交互思路；本工程使用 Vue3 和 REST/SSE。
