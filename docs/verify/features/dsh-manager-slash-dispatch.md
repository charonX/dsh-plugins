# Dsh Manager Slash 下发与首行提纯

## Sub-features

- Board 页（`BoardPage`）手工建单弹窗接入 `SlashInput`，且 `agentKindOptions` 动态读取对应外部 Agent 的 `slashCommands`
- `buildExternalCliPrompt` 将流程步骤目标、Mandate 或工单标题中的领先 `/command ...` 提纯到 CLI prompt 首行第 0 字节，同时在下方上下文中保留工单详情与挂载技能信息

## How to get to it (user POV)

进入左侧栏 `dsh-manager` 面板，打开 `Board` 标签页的「手动输入一件事」弹窗并在描述输入框中键入 `/`。

## Driving it

1. UI 级校验：打开 `dsh-manager` 的 `Board` 标签页，点击「手动输入一件事」，在描述输入框（`SlashInput`）键入 `/` 验证命令补全与插入（对应 Playwright E2E `e2e/dsh-manager.spec.ts`）。
2. 行为契约校验：运行 `pnpm --filter @charonx/dsh-manager test`，覆盖 `tests/client/slash-input.client.spec.ts` 与 `tests/unit/prompt-builder.spec.ts`。

## Gotchas

- `SlashInput` 的候选依赖所选 `agentKind` 是否可用且探测到了 `slashCommands`；若本地未启用外部 CLI 或无外部命令列表，菜单为空属预期行为。
- 实际派单测试应在测试工作区/临时工单下进行，并在 Cleanup 清理测试工单与产生的临时 Worktree。
