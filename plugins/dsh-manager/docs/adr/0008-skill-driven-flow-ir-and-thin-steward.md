# 0008: Skill 驱动的极简 Flow IR 与薄管家架构

日期: 2026-11-26
状态: accepted
关联: ADR-0005（团队配置 YAML 热更新）、ADR-0006（组合调度与自适应落地）、ADR-0007（提示词段落分层模板，已被本决策替代精简）

## 背景

此前 `dsh-manager`（经由 ADR-0005/0007）演化出了四套强耦合配置实体：`CrewMember` 角色卡、`Pipeline` 多环节、`RouteRule` 路由规则与 3 级 `PromptStudio` 段落覆盖模板（8 个轮次、三级继承）。实践中暴露三个核心问题：

1. **配置门槛过重**：用户要维护角色卡、流水线、路由规则与提示词覆盖才能跑通一条链路，与 `pstack` Poteto 等基于 Playbook/Skill 的极简协作模式相悖。
2. **领域耦合过深**：流程与分支隔离隐含假定「Git 代码开发 + 多人角色分工」，难以平滑承载知识创作、非 Git 目录研究、单人+多技能编排等通用任务。
3. **无 Playbook 时缺乏兜底与前端可观测性**：仅靠临时对话式 Playbook 解析会导致每次派单重复识别、前端拓扑图无法展示完整步骤链路；而未命中路由规则时创建阻塞 `Attention` 要求人工先配规则，也打断了自动推进体验。

## 决策

### 1. 用单一 canonical Schema v3（`FlowDef[]` / Flow IR）取代 Crew + Pipeline + Route + PromptStudio

- `team-config.yaml` 升级为 `version: 3`：`flows: FlowDef[]`，每条 Flow 表达：`id`、`name`、`when`（自然语言触发条件）、`workspaceMode`（`in-place` / `worktree` / `auto`）、`enabled`、`source?`（Playbook 来源与 SHA-256 缓存指纹）、`steps[]`（`id`、`name`、`skills[]`、`goal?`、`readOnly?`、`humanConfirm?`、`onFail?`、`agent?`）。
- 保留对 v1/v2 `team-config.yaml` 以及旧 storage domain（`dsh_manager_crew` / `dsh_manager_pipeline` / `dsh_manager_route`）的启动与解析期自动无损迁移（按阶段顺序、`review` 门禁 `onFail` 与路由条件收敛为 `FlowDef[]`）。
- 删除四组独立配置 UI 与三级 Prompt 覆盖内核，保留精简且不可覆盖的工具契约拼装器（`prompt-builder.ts`），并将挂载的 `SKILL.md` 方法论与可用技能索引置前。

### 2. Playbook 一次编译 + Hash 永久缓存

- 新增 `playbook-compiler.ts`：导入 Skill / 本地 Playbook 文件 / Markdown 文本时先计算内容 SHA-256。
- 命中同一 `source.hash` 且 `source.ref` 时直接复用缓存 Flow IR（零解析、零模型调用）。
- 缓存未命中时按确定性分级抽取（Frontmatter `steps[]` → Markdown 有序列表/标题与自动识别反引号 Skill、`readOnly`、审查步骤 `onFail` 回指），仅在非结构化散文且显式启用时执行一次性 LLM 抽取；源文件变更重编译时按步骤 id/位置保留用户手工绑定的 `agent` 与 `humanConfirm`。

### 3. 薄管家（Thin Steward）与默认单步通用兜底

- 移除逐环节 LLM `decide_skip` 预检；不声明 `onFail` 的普通步骤在完成汇报后由 Steward 确定性推进到下一步，零额外评审 LLM 开销。
- 仅声明了 `onFail`（如独立审查/自检门禁）的步骤触发 `steward.review`，失败时按 `onFail` 回跳目标工单（或 `'self'`）打回重做。
- 当未启用任何 Flow 或 Steward 路由返回 `none: true` 时，不再创建阻塞性的人工补规则 `Attention`，而是直接按「单步通用执行」结合可用工作区/宿主技能派发执行。

### 4. 统一技能发现与非 Git 知识创作一等支持

- `workspace-skills.ts` 同时聚合宿主 `ctx.skills`（如 `skills-manager`）与工作区 `.dsh/skills`、`.agents/skills`、`.claude/skills` 及祖先 `skills/`，严格只读读取、不复制第三方源码。
- 将 `workspaceMode: 'in-place'` 与内置 `knowledge-creation` 预设纳入一等支持，支持知识创作、目录调研与文档写作在无 Git / 无 worktree 环境下直写推进。

## 后果

1. **团队页大幅瘦身**：顶层保持 5 Tab（`Board` / `Team & Flows` / `Policy` / `Monitor` / `Settings`），`Team & Flows` 下仅保留「流程编排（FlowWorkbench）」与「可用技能（SkillCatalogSection）」两个子视图，并保留拓扑图/列表视图、Playbook 导入、预设复制与 YAML 导入导出。
2. **可观测性保留**：`DispatchRecord.prompt`、锁定契约段、Flow 链工单状态追踪以及 `.dsh-manager/flows/<rootTicketId>.md` Markdown 镜像完整保留。
3. **兼容代价**：旧 `dshManagerCrew`、`dshManagerPipeline`、`dshManagerRoute` 服务与对应独立 UI/RPC 下线，统一收敛到 `dshManagerFlow` 与 `dshManagerTeamConfig`；v1/v2 配置与旧存量通过 `migrateLegacyTeamConfig` / `migrateLegacyDomainsToFlows` 无感升级。
