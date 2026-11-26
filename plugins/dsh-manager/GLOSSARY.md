# Dsh Manager

Dsh Manager 是 DeepSeek Harness 的一个外置 bundle：从外部系统收集 Trigger，由主 Session 评估成工单，派给执行器完成，并跟踪结果与后续工作。术语沿用 dsh-superagent-prototype（`docs/001-domain.md`），在其基础上扩展。

## 对接

**Connector（连接器）**:
一类外部系统的对接实现，例如 GitLab、Jira；每类可提供 Cloud 与 Server/DC 两种部署类型。
_Avoid_: 集成、插件、适配器

**Connection（连接）**:
某个 Connector 的一份具体配置：实例地址、部署类型、认证方式与凭据，例如"公司 GitLab"。同一 Connector 可以有多个 Connection。
_Avoid_: 账号、实例、Integration

**项目（Project）**:
DSH 中一个具名的本地目录及其 Session；外部对象（GitLab 仓库、Jira 项目）映射到项目后，工单才能在其中修改代码。
_Avoid_: Workspace、仓库、Repo

## 事件

**Source（来源）**:
一条事件流。Source kind 是可复用的实现（如 GitLab MR、GitLab 流水线、Jira 工单）；Source instance 是某个 kind 在一个 Connection 上的一份配置：是否运行、监听什么。
_Avoid_: 事件源、适配器

**Trigger（触发）**:
来自某个 Source 的一条不可变事件，例如一条 MR 评论、一次流水线失败。
_Avoid_: 事件、Signal、通知

**Thread（线程）**:
按时间排列的 Trigger 序列；哪些 Trigger 属于同一 Thread 由 Source 定义（通常是同一个 MR、流水线或 Jira 工单）。
_Avoid_: 线索、话题、Conversation

**Channel（渠道）**:
Thread 的写入侧：评论、回复、状态变更等对外写操作的目标。
_Avoid_: 出口、回写

## 评估

**Eval（评估）**:
把一批 Trigger 变成一个 Decision 的过程，分 Gate 与 Assessment 两层。
_Avoid_: 分诊、Triage

**Gate（准入）**:
Eval 的确定性第一层：谁可以发起工作、以什么强度。
_Avoid_: 过滤器

**Assessment（研判）**:
Eval 中由模型做出的判断。
_Avoid_: 分析

**Decision（决定）**:
Eval 的结果：接单、停止、忽略或未完成。
_Avoid_: 结论

**Policy（策略）**:
有版本的规则：接单规则、每个 Source 各自的部分（如谁可以在那里发起工作），以及哪些动作类别需要 Approval。
_Avoid_: 规则集、rules

**Strength（强度）**:
Eval 或 Mandate 依据的强弱：明确（如工单指派给我）或推断（如一条相关评论）。
_Avoid_: 置信度、优先级

**Accept mode（接单模式）**:
Source instance 接单的方式：关闭、观察（只记录本会接单的候选）或自动。
_Avoid_: 自主等级

**Mandate（授权）**:
一次接单授予的内容：强度、范围以及所依据的 Policy 版本。后续工单继承前一工单的 Mandate，范围不得扩大。
_Avoid_: 权限、许可

**决策记录**:
Policy 中记录人的长期偏好与明确拒绝事项的部分；主 Session 只能提议条目，经人确认后生效。
_Avoid_: 记忆、Memory、黑名单

## 工单

**Ticket（工单）**:
一个获得授权的工作单元。
_Avoid_: 任务、Task、Job、Todo

**Follow-up Ticket（后续工单）**:
主 Session 审阅前一个工单的结果后，为同一条链路上的下一步建立的工单，记录它承接自哪个工单。
_Avoid_: 子工单、Subtask

**Assignment（派工）**:
一个工单与一个执行器实例的绑定；一个工单先后可以有多次派工。
_Avoid_: 执行、Run

**Subscription（订阅）**:
工单与 Thread 之间的多对多关系；已订阅 Thread 上的新 Trigger 会作为上下文送达工单。
_Avoid_: 关注、Watch

**Report（报告）**:
派工向工单汇报的状态：进展、等待、就绪、受阻、失败、无需处理。
_Avoid_: 回执

**Turn（轮次）**:
一次派工在工单时间线上的分段；一轮可以有多条指令、回复与工具活动。工单结束后继续，会接着同一执行会话开启新的轮次。
_Avoid_: 会话、Run

**Timeline（时间线）**:
一张工单的业务事件账本，按发生顺序记录人的指令、执行器回复与工具活动、报告、待人工决定、产出与系统结论（如复核打回、结束）。由插件域持久化，不依附任何 Session，会话丢失或被冷恢复后仍然完整。
_Avoid_: 对话、聊天记录、Session 日志

**Attention（待人工决定）**:
工单上一个等待人回答的事项，分为提问、Approval 与验收三种。
_Avoid_: 通知、提醒

**Approval（审批）**:
执行器执行某个高风险动作（如对外写操作）前必须由人批准的 Attention。
_Avoid_: 审批闸门、Gate、确认框

**验收**:
人确认一个工单已经完成的 Attention；工单只有经验收才算完成。
_Avoid_: 审阅、Review

**Deliverable（产出物）**:
执行一个工单得到的、可供人查看的结果，例如分析报告、补丁、回复草稿。
_Avoid_: 产物、Artifact、输出

## 角色

**Main Session（主 Session）**:
常驻的 DSH Session（界面中称「管家 / Steward」）：评估 Trigger、接单并派工、审阅报告、建立后续工单；它自己不执行工单。
_Avoid_: Router、Orchestrator、调度器

**Executor（执行器）**:
运行派工的端口：每个工单一个 Executor Session 和一个工作目录。
_Avoid_: Worker、子代理

**Watchdog（看门狗）**:
定时检查派工是否卡住或连续失败、Connection 是否失效的角色，发现异常时生成 Attention。
_Avoid_: 监控、健康检查

## 团队与 Flow IR

**Flow（流程 / Flow IR）**:
`team-config.yaml` v3 中的唯一编排原语（`FlowDef`）：包含自然语言触发条件（`when`）、工作目录模式（`workspaceMode`: `in-place` | `worktree` | `auto`）、可选 Playbook 缓存来源（`source`）与有序步骤链表（`steps[]`）。取代原 `CrewMember`、`Pipeline`、`RouteRule` 与三级 `PromptStudio` 覆盖。
_Avoid_: 四件套配置、流水线+路由规则分离模型

**Step（步骤）**:
Flow 中的单个节点（`FlowStepDef`）：指定挂载技能（`skills[]`）、可选一句话补充目标（`goal`）、只读边界（`readOnly`）、失败打回目标（`onFail`）、可选人工确认门禁（`humanConfirm`）及可选执行体覆盖（`agent`）。不声明 `onFail` 的步骤完成后由 Steward 确定性推进，不消耗门禁评审轮次。
_Avoid_: 重角色卡绑定、skippable 预检环节

**Playbook Cache（Playbook 一次编译与 Hash 缓存）**:
通过 `playbook-compiler` 将 `SKILL.md` 或 Markdown Playbook 一次性抽取为结构化 Flow IR 并记录 `source.hash`（SHA-256）；只要源文件哈希未变，永久直接复用缓存结果，不再重复解析或消耗模型调用。
_Avoid_: 每次派工临时重读重解析 Playbook

**单步通用执行（Single-Step Fallback）**:
当尚未启用任何 Flow 或 Steward 路由返回 `none: true` 时，直接按默认执行器配合工作区可用技能清单执行当前工单，不弹出阻塞性的「请补充路由规则」Attention。
_Avoid_: 路由未命中即挂起阻断

**流程记录（Flow Run）**:
一条 Flow 的执行进度：同一 Flow 的步骤工单按序推进，进度就是链条上各工单的状态，不设独立的流程运行期状态机存储。
_Avoid_: 进度条、执行日志、状态机、快照

## 并行调度与自适应落地

**前置依赖（Prerequisite / `dependsOn`）**:
当一张根工单与另一张在途工单存在代码文件冲突或执行顺序依赖时，在 `todo` 列挂载的前置根工单 ID；前置工单进入 `ended` 前不会派工，前置完成后由 `Executor` 自动唤醒，人工也可在工单详情解除等待。不为此新增第 7 个看板列。
_Avoid_: 开发主管、独立阻塞列、任务队列锁

**被覆盖（Superseded / `supersededBy`）**:
Steward Eval 结合全局在途与近期已完成工单上下文，发现新收到的缺陷或线程已被某张既有工单解决或纳入范围时，直接 `ignore` 并在决策审计记录中标注对应的既有工单 ID，避免重复派工。
_Avoid_: 自动关停别人分支、静默丢弃无记录

**自适应落地（Adaptive Landing）**:
交付环节不依赖静态 `projects:` 配置文件，而是按目标仓库实时发现 `AGENTS.md` / `CLAUDE.md`、项目局部 PR/发布 Skill 与远端/分支事实决定落地动作（`check_branch_rebase`、`local_merge_branch`、`push_branch`、`create_mr_or_pr`），高风险写操作继续经由 `Approval` 审批，并受同项目串行锁保护；规则缺失或存在歧义时默认安全停留在已验证的当前分支等待人工指示。
_Avoid_: 静态项目配置表、自动强推 main、跳过冲突恢复

## 提示词拼装与项目事实

**Prompt Builder（极简提示词拼装器）**:
`src/prompt/prompt-builder.ts`：负责组装执行器与管家轮次提示词，将当前步骤挂载的 `SKILL.md` 方法论与可用技能清单置前，并保留系统确定性的只读契约段（`scope`、`report`、`ask`、`approval`、`deliver`）。不再提供三级可视化段落覆盖。
_Avoid_: Prompt Studio 三级模板引擎

**契约段（Locked Section）**:
承载系统确定性边界与工具调用契约的只读段落（`scope`、`report`、`ask`、`approval`、`deliver`），在派工历史中保留可审计结构并不可被用户配置改写。
_Avoid_: 可配置提示词块

**项目事实（Project Facts）**:
派工时直接从目标项目目录与 `workspaceRegistry` 动态读取的 `AGENTS.md` / `CLAUDE.md`、`docs/git-flow.md`、`docs/verify/README.md`、可用技能列表与落地模式，保证 Flow 配置零仓库硬编码。
_Avoid_: 静态项目片段文件
