# External Agents 对话输入控制

## Sub-features

- 对话输入框右侧 `AgentSwitcher` 切换外部 Agent（`ext-claude-code`、`ext-pi`、`ext-codex`、`ext-agy`）
- 按所选 Agent 动态过滤可用模型列表
- 模型菜单提供与 Native 一致的 `推理等级`（Effort）行；所选等级随请求传给对应 CLI
- 按所选 Agent 切换对应权限控制（`PermissionControl`）
- 在输入框中输入 `/` 实时探测并展示对应外部 CLI 的 slash commands

## How to get to it (user POV)

在 `dsh web` 任意新建对话窗口的输入区右侧，切换不同外部 Agent，检查模型选择器、权限控件与 `/` 补全菜单。

## Driving it

1. 打开新会话（首轮未开始前可切换 Agent；首轮发送后会话锁定该 Agent，模型仍可在同 provider 内切换）。
2. 依次切换到各 `ext-*` Agent，确认模型列表过滤结果只包含该 Agent 支持的模型/provider。
3. 切到任一外部 Agent 后打开模型菜单，确认出现 `推理等级` 行；选择一档后触发文案更新，发送一轮并在 CLI 侧确认对应参数（Claude `--effort`、Pi `--thinking`、Codex `-c model_reasoning_effort`、Antigravity ACP `thought_level`）。
4. 在输入框键入 `/`，观察是否触发命令探测并列出可用 `/command` 项。
5. 配合运行 `pnpm --filter @charonx/dsh-external-agents test` 验证核心过滤、推理等级投影与 CLI 参数构造逻辑。

## Gotchas

- 若某外部 CLI 在本机未安装或未认证登录，对应 Agent 应优雅降级/显示不可用状态，不应拖垮整页渲染。
- Headless 会话路由按 `ext-*` 自动分发，验证时注意核对最终发起进程对应的 CLI adapter。
- 外部 Agent（尤其 `ext-agy` / Claude Code）在工具调用未结束前输出思考或文本流时会触发切 step，务必确保 `step/end` 前已闭合所有 `pendingToolCalls` 且每个并行/后台恢复工具均已通过 `assistant/message` 声明，避免冷加载 `SessionFormatError`（由 `tests/turn-driver.spec.ts` `assertV4ToolStepLifecycle` 门禁守护）。
