# 工具、Skill 与宿主扩展

## 添加本地工具

工具集中在 `apps/agent-server/src/tools.ts`。使用 Pi `defineTool` 声明参数与执行逻辑，例如：

```ts
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

const echo = defineTool({
  name: 'echo',
  label: 'Echo',
  description: 'Return the supplied text.',
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, { text }) => ({
    content: [{ type: 'text', text }],
    details: {},
  }),
});
```

将工具加入 `createAssistantTools()` 返回的数组，同时将名称加入 `pi-runtime.ts` 创建会话时的 `tools` 显式允许列表。通用工具卡片会展示名称、参数、状态及结果。

较长操作应接收并遵守工具执行的取消信号。确定性的权限、参数校验与数据边界应由工具实现或其调用的服务负责。

## 添加 Skill

目录结构：

```text
skills/
  release-notes/
    SKILL.md
```

`SKILL.md` 示例：

```markdown
---
name: release-notes
description: Organize supplied changes into concise release notes.
---

Group supplied changes into features, fixes and compatibility notes.
Ask for missing information instead of inventing changes.
```

当前示例采用显式提示词清单：新增 Skill 后，在 `pi-runtime.ts` 的 `systemPrompt()` 中登记名称、用途和适用条件。模型通过 `read_skill({ name: 'release-notes' })` 按需读取正文。

`read_skill` 只接受指定目录下的 Skill 名称，检查真实文件路径，拒绝目录穿越与符号链接逃逸。默认不载入个人 Pi 配置、全局 Skills 或扩展。

## 接入 MCP

当前运行示例使用本地工具。接入 MCP 时，可在 Node 服务中连接 MCP Server，将其工具适配为 Pi `ToolDefinition`，并通过相同允许列表注册。

连接、鉴权、超时、取消信号与返回值适配由服务端处理；前端通用工具卡片和 REST/SSE 协议可以继续使用。

## 嵌入 Vue3 宿主

组件位于 `apps/web/src/components/AssistantShell.vue`，网络与状态逻辑位于 `apps/web/src/assistant`。

```vue
<script setup lang="ts">
import { ref } from 'vue';
import AssistantShell from './components/AssistantShell.vue';

const open = ref(false);
</script>

<template>
  <AssistantShell
    v-model:open="open"
    base-url="/api/assistant"
    :page-context="{ page: '文档中心' }"
  />
</template>
```

在根布局挂载一次即可让浮动入口跨页面使用。迁移时保留共享协议依赖，并引入 Element Plus 与助手所需样式；宿主演示样式可按需裁剪。

`pageContext` 是模型参考内容，不作为服务端配置或工具权限来源。
