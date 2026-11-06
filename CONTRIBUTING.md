# 贡献指南

欢迎提交问题、修复和扩展。

## 开发

1. 使用 Node.js >= 22.19.0、pnpm 10.30.3。
2. 执行 `pnpm install --frozen-lockfile`。
3. 将 `.env.example` 复制为 `.env` 并填写本地模型配置。
4. 执行 `pnpm dev`。

模型凭据、聊天数据和临时测试产物均应留在被 Git 忽略的路径中。

## 提交前检查

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
git diff --check
```

UI 修改请附桌面或移动端截图。修复行为问题时，补充能够复现该问题的测试。`pnpm test:live` 是可选真实模型检查，需要已配置并启动服务。

## 边界

- 共享传输类型放在 `packages/protocol`，避免前端直接依赖 Pi 内部类型。
- 保留事件序号、重连去重和任务终态语义。
- 工具在服务端显式登记，Skill 从受控目录按需读取。
- 变更会话持久化格式或 Pi SDK 版本时，验证历史恢复、取消和工具调用。
- 使用本地可控端点测试失败路径，避免默认测试依赖第三方服务。

通过贡献本项目，你同意贡献内容按项目的 MIT 许可证提供。
