# DSH Verify Feature Map

按用户视角索引 `repos/dsh` 需重点验证的功能与狗粮闭环场景。

| Feature | 说明 | 文档 |
|---|---|---|
| Harness 与插件兼容性 | 验证 `deepseek-harness` 产物对齐、仓库卫生门禁及全插件 typecheck / build / vitest | [harness-plugin-compat.md](harness-plugin-compat.md) |
| Web 启动与侧栏渲染 | 验证 `dsh web` 启动、侧栏自建插件入口、5-Tab 切换与深浅色 token | [web-boot-and-sidebar.md](web-boot-and-sidebar.md) |
| External Agents 对话输入 | 验证按 Agent 过滤模型、权限切换与 `/` 实时命令探测 | [external-agents-composer.md](external-agents-composer.md) |
| Dsh Manager Slash 下发 | 验证 Board 手工建单 `SlashInput` 与 `buildExternalCliPrompt` 首行第 0 字节提纯 | [dsh-manager-slash-dispatch.md](dsh-manager-slash-dispatch.md) |
| Dsh Manager 流程与工单工作台 | 验证 Schema v3 Flow IR、Playbook 缓存、`ctx.skills` 聚合、域账本时间线与结束后同会话继续 | [dsh-manager-flow-and-workbench.md](dsh-manager-flow-and-workbench.md) |
| Dsh Manager 团队配置热更新 | 验证 `team-config.yaml` v3 热加载、校验告警与 MCP 配置工具注入 | [dsh-manager-team-hot-reload.md](dsh-manager-team-hot-reload.md) |
