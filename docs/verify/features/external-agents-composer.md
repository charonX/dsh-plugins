# External Agents 配置、选型与对话控制

## Sub-features

- 右下角 `AgentSwitcher`（`conversation.input.right`）切换外部 Agent（`agy`、`claude-code`、`pi`、`codex`），不向原生模式菜单注入 `ext-*` `AgentPreset`，也不向 `ctx.llm` 注册 `ext-*` 占位供应商
- 右下角单弹层选型器（`ExternalModelControl`）：点击模型触发器在一个弹层内同时选择「思考强度」（顶部胶囊，即时生效）与「模型」（下方可搜索列表），所选模型与强度保存在插件独立会话状态并随请求透传给对应 CLI（Antigravity ACP `thought_level`、Claude `--effort`、Codex `-c model_reasoning_effort`、Pi `--thinking`）
- 设置页（`settings.section` → `第三方 CLI` / `External CLIs`）：查看各第三方 CLI 安装状态、版本、可执行路径、认证摘要、订阅额度（Antigravity 主动探测 `agy /usage`；Claude 被动捕获 `rate_limit_event`；Codex 支持观测快照；Pi 明确标注不支持），并配置新会话默认 Agent 及各 CLI 的默认模型/思考强度/自定义模型
- 按所选 Agent 切换对应权限控制（`PermissionControl`）
- 在输入框中输入 `/` 实时探测并展示对应外部 CLI 的 slash commands
- 保留 `ExternalAgentsService`（`ctx.externalAgents`）与 `getCatalog()`，确保 `dsh-manager` 流程节点（`FlowWorkbench` / `flow-service.ts`）仍可选择第三方 CLI 并附着斜杠指令

## How to get to it (user POV)

1. 打开 `dsh web` 的「设置 → 第三方 CLI」，查看各 CLI 状态与订阅额度，按需配置默认模型与思考强度。
2. 在任意新建空白对话窗口的输入区右下角，通过 `AgentSwitcher` 切换第三方 CLI，点击旁边的单弹层模型/强度选型器一步调整思考强度与模型。
3. 打开 `dsh-manager` 流程编辑弹窗，确认步骤节点「执行器 / Agent」仍可选择第三方 CLI。

## Driving it

1. 打开「设置 → 第三方 CLI」，确认 Antigravity 展示版本与 `agy /usage` 5h/周限额进度条、Pi 标注无配额接口、修改默认模型/强度后重开页面保留生效。
2. 确认原生左侧模式菜单与「设置 → 模型」中均不存在 `ext-*` 占位条目。
3. 在新建会话右下角切换到任一第三方 CLI（如 `Antigravity`），确认单弹层内顶部思考强度分段条可即时切换、下方模型列表点击即选定关闭；首轮发送后 `AgentSwitcher` 锁定而单弹层选型器仍可切换模型与强度。
4. 配合运行 `./check-plugins-against-harness.sh external-agents` 与 `dsh-manager` flow 测试确认全绿。

## Gotchas

- 若某外部 CLI 在本机未安装或未认证登录，对应 Agent 应优雅降级/显示不可用状态，不应拖垮整页渲染。
- Headless 会话路由按 `ExternalSessionStore` 及历史会话事件回退分发，验证时注意核对最终发起进程对应的 CLI adapter 与透传参数。
- 外部 Agent（尤其 `agy` / Claude Code）在工具调用未结束前输出思考或文本流时会触发切 step，务必确保 `step/end` 前已闭合所有 `pendingToolCalls` 且每个并行/后台恢复工具均已通过 `assistant/message` 声明，避免冷加载 `SessionFormatError`（由 `tests/turn-driver.spec.ts` `assertV4ToolStepLifecycle` 门禁守护）。
