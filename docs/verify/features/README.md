# DSH Verify Feature Map

按用户视角索引 `repos/dsh` 需重点验证的功能与狗粮闭环场景。

| Feature | 说明 | 文档 |
|---|---|---|
| Harness 与插件兼容性 | 验证 `deepseek-harness` 产物对齐及全插件 typecheck / build / vitest | [harness-plugin-compat.md](harness-plugin-compat.md) |
| Web 启动与侧栏渲染 | 验证 `dsh web` 启动、侧栏自建插件入口、页面切换与深浅色 token | [web-boot-and-sidebar.md](web-boot-and-sidebar.md) |
| External Agents 对话输入 | 验证按 Agent 过滤模型、权限切换与 `/` 实时命令探测 | [external-agents-composer.md](external-agents-composer.md) |
| Dsh Manager Slash 下发 | 验证 Stage / Board `SlashInput` 与 `buildExternalCliPrompt` 首行第 0 字节提纯 | [dsh-manager-slash-dispatch.md](dsh-manager-slash-dispatch.md) |
| Dsh Manager 提示词工作台 | 验证 8 轮提示词三级覆盖、锁定段防护、动态项目事实预览、实发回看与预设复制 | [dsh-manager-prompt-studio.md](dsh-manager-prompt-studio.md) |
