# Dsh Manager 提示词工作台与流程预设

## Sub-features

- 8 个内置轮次（`executor`、`external-cli` 及 `steward.*` 6 轮）段落注册表与 `stage > pipeline > global > builtin` 三级覆盖
- 锁定契约段（`scope`、`report`、`ask`、`approval`、`deliver`、`headless`、`tool`）在 UI / YAML / Agent 工具全链路只读拦截
- `{{var}}` 变量插值与动态项目事实解析（`{{project.agentsMd}}`、`{{project.verifyDocs}}` 等），缺失值自动省略整行、未知变量保存前拒绝
- 执行器提示词随 `DispatchRecord.prompt` 落库（工单详情折叠回看），管家轮次保留最近 20 份缓存（`MonitorPage` 活动展开）
- 团队页「提示词」子视图（实时预览、二次确认保存、YAML 剪贴板导出/校验导入）及 3 条只读流水线预设一键复制

## How to get to it (user POV)

1. 进入左侧栏 `dsh-manager` 面板 → `团队` → `提示词` 子视图浏览与编辑各轮次/流水线/环节提示词，并在底部选择项目与工单进行实时渲染预览；
2. 在 `团队` → `编排工作台` 点击「从预设复制」一键生成需求实现 / 缺陷修复 / 只读分析流水线；
3. 派发工单后在工单详情展开「实际下发提示词」，或在 `运行监控` → `管家活动` 点击「查看提示词」核对实发内容。

## Driving it

- 单元测试与金标门禁：`pnpm --filter @charonx/dsh-manager test`（`tests/unit/prompt-kernel.spec.ts`、`tests/unit/team-config-core.spec.ts`、`tests/unit/presets.spec.ts`）
- 客户端与 Boot 集成：`tests/client/prompt-studio.client.spec.ts`、`tests/boot/prompt-studio.boot.spec.ts`
- Playwright E2E：`pnpm --filter @charonx/dsh-manager e2e`

## Gotchas

- `team-config.yaml` 保存在 `<DSH_HOME>/dsh-manager/team-config.yaml`（不在业务仓 Git 内），重大调整前建议使用工具条「导出 YAML」备份。
- 管家活动提示词仅在进程内存保留最近 20 份，重启或超出窗口后条目仍保留但提示词正文提示已过期。
