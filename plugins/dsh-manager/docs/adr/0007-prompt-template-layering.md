# 0007: 提示词段落分层模板、契约锁定与动态项目事实变量

日期: 2026-11-25
状态: accepted
关联: ADR-0005（团队配置 YAML 热更新）、ADR-0006（组合调度与自适应落地）

## 背景

`dsh-manager` 的执行器信封（内置执行器 / 外部 headless CLI）与管家 6 个轮次提示词长期硬编码在 `executor-service.ts` 与 `steward-service.ts` 中，存在三个核心问题：

1. **不可见、不可调**：团队成员只能改 `member.role` 与 `stage.instruction`，无法调整产物约定、上下文引导、排期/去重/worktree 提示词；
2. **流程定义与仓库强耦合**：若在阶段指令中写死某个仓库的验证命令或目录假设，同一流水线无法复用到不同项目；
3. **排障难追溯**：派工记录和管家活动条目不保留实际下发给模型的提示词全文，难以事后定位模板配置导致的编排漂移。

## 决策

### 1. 段落注册表 + 三级覆盖（`stage > pipeline > global > builtin`）

- 在 `src/prompt/` 建立不可重排的段落注册表 `TURN_REGISTRY`，覆盖 `executor`、`external-cli` 与 6 个 `steward.*` 轮次；
- 覆盖层定义在 `team-config.yaml` schema v2 中：`prompts.turns.<turn>.sections`（全局）← `pipeline.prompt.sections`（流水线）← `stage.prompt.sections`（环节）；
- `version: 1` 与 `version: 2` 双向兼容读取，无提示词覆盖时保留 `version: 1`，存在覆盖时自动落盘 `version: 2`。

### 2. 确定性契约段锁定（Fail-Closed）

- `scope`、`report`、`ask`、`approval`、`deliver`、`headless`、`tool` 设为只读锁定段；
- 锁定校验同时作用于 UI（无编辑框）、`team-config.yaml` 解析热加载、Agent 配置工具（`dsh_manager_*`）与 `promptSave` RPC；任何途径尝试覆盖均拒绝写入并保留上一份有效配置。

### 3. 纯 `{{var}}` 插值 + 动态项目事实解析（不做条件语言/项目片段文件）

- 只支持 `{{var}}` 简单变量插值：缺失值渲染为空并删除因此变空的整行，未知变量在保存前直接拒绝；
- 明确不引入条件块/循环模板语法，也不新造独立「项目片段文件」，避免维护第二套项目元数据；`{{project.*}}` 与 `{{skills.list}}` 在派工/预览时直接从 `workspaceRegistry`、仓库 `AGENTS.md` / `docs/verify/` / `docs/git-flow.md` 及 `landing-discovery` 动态读取；
- 每次渲染保留 64 KB 上限（超限截断并标记）：执行器提示词落库到 `DispatchRecord.prompt`（供 `TicketDetail` 回看），管家轮次提示词保留最近 20 份内存缓存并通过 `dshManager/stewardPrompt` 供 `MonitorPage` 展开查看。

### 4. 只读预设与一键复制

- 内置 3 条只读流水线预设（需求实现 / 缺陷修复 / 只读分析），全量使用变量占位；
- 复制时按 `(agentKind, role)` 复用现有队员或自动新建，生成的流水线与预设完全解耦、可自由编辑与删除。

## 后果

- **正向**：模型可见提示词全面透明、可分级定制且可追溯；流程与仓库彻底解耦；
- **约束**：新增变量必须先在 `PROMPT_VARIABLES` 注册并绑定到既有宿主/领域事实源，不能绕过校验直接拼接未知占位符。
