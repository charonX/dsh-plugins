# Dsh Manager Slash 下发与首行提纯

## Sub-features

- Team 页（`TeamPage`）流水线 Stage 指令编辑接入 `SlashInput`，且 `agentKindOptions` 动态读取对应外部 Agent 的 `slashCommands`
- Board 页（`BoardPage`）手工建单接入 `SlashInput`
- `buildExternalCliPrompt` 将 Stage 指令、Mandate 或工单标题中的领先 `/command ...` 提纯到 CLI prompt 首行第 0 字节，同时在下方 `Context:` 中保留其余上下文

## How to get to it (user POV)

进入左侧栏 `dsh-manager` 面板，分别在 `Board` 手工建单弹窗与 `Team` 流水线 Stage 配置区选择外部 Agent 并在指令框中输入 `/`。

## Driving it

1. UI 级校验：打开 `dsh-manager` 的 `Team` 标签页选择可用 `ext-*` 外部 Agent，在 Stage 指令框（`SlashInput`）键入 `/` 验证命令补全与插入；再切到 `Board` 标签页验证手工建单弹窗内 `SlashInput` 行为一致。
2. 行为契约校验：运行 `pnpm --filter @charonx/dsh-manager test`，重点覆盖 `buildExternalCliPrompt` 对首行第 0 字节 `/command` 提纯及工单上下保留的断言。

## Gotchas

- `SlashInput` 的候选依赖所选 `agentKind` 是否可用且探测到了 `slashCommands`；若选择原生内建 Agent 且无外部命令列表，菜单为空属预期行为。
- 实际派单测试应在测试工作区/临时工单下进行，并在 Cleanup 清理测试工单与产生的临时 Worktree。
