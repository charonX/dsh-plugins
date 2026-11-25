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

## 团队

**队员（Crew Member）**:
一张角色卡：名字、职责提示词、模型与工具约束。流水线环节引用它；派工时它的职责提示词随任务附带。执行体（Agent Kind）记录队员由谁执行：默认内置执行器；Claude Code、Codex 等外部 agent 接入后按执行体派工，模型与提供方沿用外部 agent 自己的配置。
_Avoid_: 子代理、Sub-agent、Agent 配置

**流水线（Pipeline）**:
一条有序的环节序列；工单按它逐环节派工。可被多条路由规则复用。
_Avoid_: 工作流、Workflow、流程模板

**环节（Stage）**:
流水线的一个节点：引用一个队员并附加本环节指令，标注是否可跳过及跳过逻辑。一个环节执行为一张工单。
_Avoid_: 步骤、Step、任务

**路由规则（Route Rule）**:
分配规则：一段自然语言的条件描述，命中时把工单交给对应的流水线。未命中任何规则时交给人工判断，并建议补充流程。
_Avoid_: 分支、条件规则、默认流程

**流程记录（Flow Run）**:
一条流程的执行进度：同一流程的环节票按序推进，进度就是链条上各票的状态，不设独立的流程存储。
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

## 提示词模板与流程预设

**提示词模板（Prompt Template）**:
按轮次注册的段落化模板定义，支持 `builtin` ← `global` ← `pipeline` ← `stage` 三级覆盖与 `{{var}}` 变量插值；实际渲染全文在派工/管家执行时保留可追溯原文。
_Avoid_: 字符串硬编码拼接、脚本式模板引擎

**段落（Prompt Section）**:
轮次提示词内带稳定 ID 的最小可覆盖单元，在注册表中顺序固定，支持查看来源徽标并按层恢复继承或恢复默认。
_Avoid_: 可随意拖拽重排的片段

**契约段（Locked Section）**:
承载系统确定性边界与工具调用契约的只读段落（`scope`、`report`、`ask`、`approval`、`deliver`、`headless`、`tool`），在 UI、YAML 热加载与 Agent 工具三条写入路径均禁止覆盖。
_Avoid_: 可配置提示词块

**变量上下文（Prompt Context）**:
在派工或实时预览时由代码从工单、流水线、环节、队员、项目事实与环境变量组装的只读键值集合；缺失值使对应整行省略，未知变量在保存前拦截。
_Avoid_: 独立手工维护的环境变量表

**轮次（Turn）**:
模型交互的顶层提示词入口，共 8 个：`executor`、`external-cli` 与 `steward.{batch-eval,eval,route,skip,review,end-suggestion}`。
_Avoid_: 提示词文件、Prompt Preset

**项目事实（Project Facts）**:
派工或预览时直接从目标项目目录与 `workspaceRegistry` 动态读取的 `AGENTS.md` / `CLAUDE.md`、`docs/git-flow.md`、`docs/verify/README.md`、技能列表与落地模式，保证流程配置零仓库硬编码。
_Avoid_: 静态项目片段文件
