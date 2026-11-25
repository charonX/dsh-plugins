# Spec 0001：Dsh Manager——外部 Trigger 收集与主 Session 工单看板

状态：ready-for-agent（本地草稿，尚未发布到 issue tracker）

术语以 [GLOSSARY.md](../../GLOSSARY.md) 为准；相关决策见 [ADR-0001](../adr/0001-out-of-tree-bundle-design-only-reference.md)、[ADR-0002](../adr/0002-action-level-approval.md)。

## Problem Statement

我同时跟进多个 GitLab 仓库的 MR 和流水线，以及 Jira 上指派给我的工单。这些变化散落在各个系统里，我只能靠自己反复打开网页去发现：流水线失败了、MR 有了新评论、Jira 工单被指派过来了。

发现之后，我还要手动打开 DSH，挑一个项目，开一个 Session，把背景再讲一遍，盯着它干完，再回到外部系统去回复或更新状态。一个人同时只能跟住三到五个 Session，注意力成了瓶颈。到底有多少事在进行、谁卡住了、哪些产出物还没验收，没有一个地方能统一看到。

我希望 DeepSeek Harness 像一个管家一样替我值守：主动收集这些事件，整理成工单，派 agent 去做，跟踪结果并安排后续工作。我只负责做决定和验收。

## Solution

在 DSH（web/desktop）中安装 Dsh Manager bundle 后，侧边栏会出现统一入口，主面板包含五个一级 Tab：**看板 / 团队 / 策略 / 运行监控 / 设置**。

- **对接与触发（设置）。** 在设置页中配置一个或多个 GitLab、Jira 的 Connection，填写实例地址、部署类型和凭据。页面会检测所需依赖（如 `glab`）是否安装，并测试能否连通。然后为每个 Connection 配置要监听什么（Source instance），并把外部的 GitLab 仓库或 Jira 项目映射到 DSH 的项目。
- **收集与接单。** Dsh Manager 按配置定时轮询，把每条变化记成 Trigger 并归入 Thread。常驻的主 Session 批量评估这些 Trigger，按 Policy 和接单模式决定接单、忽略或停止。依据明确的工作自动接单；推断出的工作先作为候选放进看板，我点了才接。
- **执行。** 接下的工单会派给执行器：在对应项目里新开一个 worktree，启动一个 Executor Session 去干活。低风险动作直接执行；对外写操作等高风险动作会先在看板上生成一条 Approval，等我批准。
- **审阅与后续。** 执行器汇报后，主 Session 审阅结果，可能要求返工，或者建立后续工单（比如修好 MR 之后跟踪流水线），最后交给我验收。
- **看板与产出物。** 看板按"待接单 / 未完成 / 待办 / 进行中 / 待人工 / 已结束"展示全部工单。点开工单可以看到它的 Thread、派工历史、Report、Attention 和所有 Deliverable，每个 Deliverable 都能跳回产生它的那一轮对话。
- **看门狗（Watchdog）。** Watchdog 定期检查卡住的派工或失效的 Connection，发现异常时生成一条 Attention 提醒我。（原「晨间简报」特性已在 2026-11-24 信息架构重构中彻底下线移除。）

## User Stories

### 对接管理

1. 作为用户，我想在配置页添加一个 GitLab Connection（实例地址、部署类型、Personal Access Token），以便 Dsh Manager 能读取公司 GitLab 的数据。
2. 作为用户，我想添加多个 GitLab Connection（例如公司实例和个人实例），以便同时跟进多个 GitLab。
3. 作为用户，我想添加一个或多个 Jira Connection，并选择 Server/DC 或 Cloud 部署类型，以便接入不同的 Jira 实例。
4. 作为用户，在连接自建 Jira 时，我想选择 PAT 或用户名加密码的认证方式，以便适配公司实例允许的方式。
5. 作为用户，在连接 Jira Cloud 时，我想用邮箱加 API token 认证，以便日后接入云端实例。
6. 作为用户，我想让凭据保存在 DSH 的凭据存储中，不以明文写入配置，以便它不会出现在配置文件或日志里。
7. 作为用户，我想在凭据过期或轮换后直接更新凭据，无需重启 DSH，以便维护不打断正在进行的工作。
8. 作为用户，我想让配置页自动检测某个 Connector 所需的本地依赖（如 `glab`）是否已安装，以便配置前就知道缺什么。
9. 作为用户，当依赖缺失时，我想看到适合我所用平台的安装指引和可一键复制的命令，以便自己完成安装。
10. 作为用户，我想对一个 Connection 点"测试连接"，看到成功，或者具体的失败原因（地址不通、凭据无效、权限不足），以便快速排查问题。
11. 作为用户，我想在配置页的每个 Connection 卡片上看到它的状态（未配置 / 依赖缺失 / 凭据无效 / 正常），以便一眼掌握对接健康度。
12. 作为用户，我想编辑、停用或删除一个 Connection，以便管理不再使用的对接。
13. 作为用户，我想把一个 GitLab 仓库映射到 DSH 中的某个项目，以便该仓库的工单可以在本地代码里修改。
14. 作为用户，我想把一个 Jira 项目映射到 DSH 中的某个项目，以便 Jira 工单知道去哪里改代码。
15. 作为用户，我想把多个外部对象映射到同一个 DSH 项目，以便一个代码库关联它的 MR、流水线和 Jira 项目。
16. 作为用户，我想在配置映射时从 DSH 已有的项目列表里选择，以便映射与 DSH 的项目保持一致。

### Source instance 与轮询

17. 作为用户，我想为 GitLab Connection 启用"指派给我的 MR、我是 reviewer 的 MR、我创建的 MR 上的新评论"这一 Source instance，并使用合理的默认值，以便开箱即用。
18. 作为用户，我想为 GitLab Connection 启用"我关注的项目里失败的流水线"这一 Source instance，以便第一时间知道构建出问题。
19. 作为用户，我想为 Jira Connection 配置一条 JQL，默认是指派给我且未解决的工单，以便精确控制收集范围。
20. 作为用户，我想为每个 Source instance 设置轮询间隔，以便在实时性和 API 配额之间取舍。
21. 作为用户，我想让每个 Source instance 记住读取位置，DSH 重启后不会重复收集已处理的变化，以便不产生重复工单。
22. 作为用户，我想单独启用或停用某个 Source instance，以便临时屏蔽噪音来源。
23. 作为用户，我想为每个 Source instance 设置接单模式（关闭 / 观察 / 自动），以便控制它能否自动产生工作。
24. 作为用户，我想让依据明确的工作（指派给我的 MR 或 Jira 工单、我创建的 MR 流水线失败）默认自动接单，以便最常见的工作无需我介入。
25. 作为用户，我想让依据推断的工作（别人 MR 里与我相关的评论）默认只观察，以便我先看一眼再决定接不接。
26. 作为用户，我想在一个只读的 Trigger 浏览页上看到收集到的 Trigger 及其所属 Thread，以便确认收集是否正确。
27. 作为用户，我想让同一条变化即使被多次拉取，也只记录一次 Trigger，以便评估和工单不受重复数据干扰。
28. 作为开发者，我想让 Source 的设计允许以后用 webhook 投递 Trigger，且无需改动 Trigger、Thread 及其下游，以便后续加入 webhook 时向后兼容。

### 评估与接单

29. 作为用户，我想让常驻的主 Session 按批评估同一 Thread 上新到的 Trigger，以便同一个 MR 上的连续评论被合并判断，而不是逐条处理。
30. 作为用户，我想让每次评估的 Decision（接单 / 停止 / 忽略 / 未完成）都有记录，并能在评估记录页查看，以便理解系统为什么接或不接某件事。
31. 作为用户，我想在看板的"待评估"列看到排队中的 Trigger 和观察模式下"本会接单"的候选，以便掌握还没变成工单的潜在工作。
32. 作为用户，我想对一个观察模式下的候选点"接单"，把它变成工单，以便在需要时把推断出的工作纳入任务池。
33. 作为用户，我想让每个工单都带一份 Mandate，记录它凭什么做、能做到多大范围、依据哪个 Policy 版本，以便事后追溯授权来源。
34. 作为用户，当一个已订阅 Thread 上来了新的 Trigger（例如 MR 上的新评论）时，我想让它作为上下文直接送达相关工单，不另起新工单，以便后续讨论能跟上正在进行的工作。
35. 作为用户，我想手动输入一件事并让它走正常评估，以便系统之外冒出来的工作也能纳入任务池。
36. 作为用户，我想直接打开主 Session 和它对话、查看它的决策过程，以便需要时干预或了解它的想法。
37. 作为用户，我想单独为主 Session 配置模型，以便按成本和效果自行取舍。

### Policy、Approval 与决策记录

38. 作为用户，我想用一份有版本的 Policy 声明哪些动作类别需要我审批，以便高风险动作永远不会悄悄发生。
39. 作为用户，我想让以下对外写操作默认需要 Approval：发评论、推送分支、开 MR、合并 MR、修改 Jira 状态、重跑流水线，以便对外可见的影响都经过我的确认。
40. 作为用户，我想让删除数据、修改凭据或权限默认需要 Approval，以便不可逆或敏感的操作受到保护。
41. 作为用户，我想让读取、分析、在独立 worktree 中改代码并跑测试、生成草稿这些低风险动作直接执行，以便常规工作不被打扰。
42. 作为用户，当执行器要执行一个需要审批的动作时，我想在看板的"待人工"列看到一条 Approval，内容包括动作内容和理由，以便知情后再批准。
43. 作为用户，我想批准或拒绝一条 Approval，必要时附上意见，以便执行器据此继续或调整做法。
44. 作为用户，我想确保执行器在得到批准之前无法执行受审批约束的动作，并且这种拦截不依赖提示词，以便审批真正可靠。
45. 作为用户，我想让主 Session 只能提议放宽某类动作的审批要求，由我确认后才写入新的 Policy 版本，以便 agent 不能自己给自己放权。
46. 作为用户，我想让主 Session 在提问或 Approval 中发现我的长期偏好（例如"依赖升级 MR 一律不接"）时提议写入决策记录，由我确认生效，以便同样的问题不再反复问我。
47. 作为用户，我想查看和编辑决策记录，以便纠正过时的偏好。
48. 作为用户，我想让主 Session 每次评估时都参考决策记录，以便它的判断符合我已经表达过的意愿。

### 执行

49. 作为用户，我想让每个需要改代码的工单在所映射项目的目录下拥有独立的 git worktree，以便多个工单并行时互不干扰，我的工作目录也不被弄乱。
50. 作为用户，我想设置同时运行的派工上限（默认 3），以便控制本机负载和 token 消耗。
51. 作为用户，我想让没有项目映射的工单只做只读分析，以便系统不会在未知位置改代码。
52. 作为用户，当主 Session 能推断出一个未映射工单应属于哪个项目时，我想以 Attention 的形式收到建议并确认，以便快速补全映射。
53. 作为用户，我想单独为执行器配置模型，以便为执行工作选用更强的模型。
54. 作为用户，我想让执行器在过程中以 Report 汇报进展、等待、就绪、受阻、失败或无需处理，以便看板反映真实进度。
55. 作为用户，当执行器需要我回答问题时，我想在"待人工"列看到这条提问并直接回答，以便它拿到答案后继续。
56. 作为用户，我想从工单直接打开它的 Executor Session，以便在需要时亲自接手或补充指令。
57. 作为用户，我想让 DSH 重启后被中断的派工能够恢复或明确标为中断，以便不会有工单悄悄消失。

### 审阅、后续工单与验收

58. 作为用户，当执行器报告就绪后，我想让主 Session 先审阅结果，再交给我，以便我只看到经过把关的产出。
59. 作为用户，当主 Session 认为结果不达标时，我想让它附上意见安排返工，以便小问题无需我介入就能修好。
60. 作为用户，我想让自动返工最多两次，超过后转给我决定，以便系统不会无休止地重试。
61. 作为用户，我想让主 Session 在审阅后为同一链路的下一步建立后续工单（例如 MR 修好后跟踪流水线结果），以便工作链条被持续跟踪。
62. 作为用户，我想让后续工单继承前一工单的 Mandate 且范围不扩大；需要更大范围时先生成 Approval，以便后续工单不会悄悄越权。
63. 作为用户，我想在工单详情中看到它承接自哪个工单、又派生了哪些后续工单，以便理解完整链路。
64. 作为用户，我想让每个工单最终都经我验收才算完成，以便"完成"真正代表我认可。
65. 作为用户，验收时我想能选择"通过"或"退回"并附上意见，以便不满意的结果回到执行流程。
66. 作为用户，当外部对象已经结束（MR 已合并或关闭、Jira 已解决）时，我想让主 Session 在相关工单上标记"建议结束"，由我确认，以便看板不残留过期工单。

### 看板与产出物

67. 作为用户，我想在 DSH 左侧导航看到"工单看板"入口，打开后是一个完整页面，以便有一个统一的工作台。
68. 作为用户，我想让看板按"待评估 / 待办 / 进行中 / 待人工 / 已结束"分列展示，以便一眼看清所有工作的状态。
69. 作为用户，我想在工单卡片上看到标题、来源（Connection 与外部对象）、所属项目、当前 Report 和待处理的 Attention 数量，以便不用点开就能分出轻重缓急。
70. 作为用户，我想按 Connection、项目、Source kind 筛选看板，以便聚焦某一块工作。
71. 作为用户，我想让看板在后台数据变化时实时刷新，以便不用手动刷新页面。
72. 作为用户，我想点开一个工单，在详情栏里看到它的 Thread（相关 Trigger）、Mandate、派工历史、Report、Attention 和 Deliverable，以便在一个地方了解全貌。
73. 作为用户，我想在工单详情中看到执行器通过 present 声明的文件、工作区改动的 diff、关联的 MR 链接和回复草稿，以便查看产出物。
74. 作为用户，我想从每个 Deliverable 跳回产生它的 Executor Session 中的那一轮对话，以便查看它的来龙去脉。
75. 作为用户，我想从工单跳转到外部对象（GitLab MR、流水线、Jira 工单）的原始页面，以便在原系统里查看。
76. 作为用户，我想在评估记录页查看被忽略的 Trigger 及其理由，以便确认没有漏掉重要的事。

### 通知与 Watchdog

77. 作为用户，当有新的 Attention 时，我想在 DSH 界面里看到看板角标和提示，以便及时处理待人工事项。
78. 作为开发者，我想让通知出口可以替换，以便日后接入飞书等 IM 时不改动产生通知的一方。
79. *(已移除：原晨间简报定时生成需求已随 2026-11-24 信息架构重构下线。)*
80. *(已移除：原晨间简报 Deliverable 历史需求已随 2026-11-24 信息架构重构下线。)*
81. 作为用户，我想让 Watchdog 发现长时间无进展或超时的派工、连续失败的派工，以及失效的 Connection，并生成 Attention，以便问题不会被静默吞掉。

### 平台与安装

82. 作为用户，我想在 Windows、macOS 和 Linux 上都能完整使用 Dsh Manager，且不需要安装 tmux 之类的平台专属工具，以便在任何开发机上运行。
83. 作为用户，我想通过 DSH 的 profile 机制安装 Dsh Manager，并且不修改 harness 本身，以便 harness 升级时插件不受影响。
84. 作为用户，我想让 Dsh Manager 随 DSH web 或 desktop 启动而运行，无需单独的守护进程，以便部署简单。
85. 作为用户，当 Dsh Manager 的配置有误（例如映射指向不存在的项目）时，我想在加载时或最早能发现的时候看到明确报错，以便不会出现静默跳过的情况。

## Implementation Decisions

### 交付形态与分层

- Dsh Manager 是 harness 仓库之外的 DSH bundle：一个 npm 包，内部是 pnpm 多包工程，通过包清单声明 bundle 和它的 cordis patch，用 DSH profile 安装。不 fork、不修改 harness。
- 所有对 harness 的依赖都是 `@deepseek-ai/dsh-*` 的 peer/dev 依赖，版本对齐本地 harness（当前为 0.2.2 预发布线）。
- 常驻进程就是 DSH web/desktop，Dsh Manager 的 Host 插件活在该进程中，不依赖任何聊天 Session。
- 原型 `dsh-superagent-prototype` 只作设计参考，代码从头写（ADR-0001）。
- 全平台兼容：子进程、路径处理和 worktree 准备都走 harness 的 subprocess/shell 能力，不写 `sh`、tmux 或依赖 `fcntl` 的脚本，也不假设路径以 `/` 开头。

### 模块划分（深模块，接口小、实现厚）

1. **领域核心**：纯逻辑、同步、无 I/O，依赖仓储端口。负责：
   - 记录 Trigger（按内容派生的 id 去重）、归入 Thread
   - Eval 批处理（每个 Thread 同一时刻最多一个 Eval，期间到达的 Trigger 并入下一批）
   - Decision 的应用，工单的创建与结束、恢复
   - Mandate 的创建与继承（后续工单的范围不得大于前一工单）
   - Subscription 扇出
   - 派工状态机
   - Attention（提问 / Approval / 验收）的生命周期
   - 自动返工计数（上限 2）
   - Policy 版本与动作类别审批判定
   - 看板列的派生

   看板列不是存储的状态，而是由工单、派工和 Attention 计算出来的。
2. **持久化适配**：领域核心仓储端口的实现。按 M0 的验证结果决定：如果 harness 的 storage-domain 能承担副作用队列所需的原子更新，就用它，它的变更事件直接驱动看板刷新；否则用独立的 SQLite 文件，再把变更事件桥接到看板。领域核心不感知这个选择。
3. **副作用队列**：持久化的对外动作队列，带重试、退避和幂等投递，包括启动派工、向 Session 投递输入、通过 Channel 写回外部系统。Channel 写回在入队前必须已经过 Approval。
4. **Connector 层**：每个 Connector（GitLab、Jira）提供以下能力：
   - 依赖检测（检测缺失时给出各平台的安装指引）
   - 连通性测试
   - 认证方式：GitLab 用 PAT；Jira Server/DC 用 PAT 或 Basic，Jira Cloud 用邮箱加 API token；部署类型可选 Cloud 或 Server/DC，先实现自建实例
   - 供 Source 读取、供 Channel 写入的已认证客户端

   GitLab Connector 以 `glab` 为基础。凭据通过 harness 的 credentials 存储并在使用时解析，不进入 cordis 配置明文。Connection 是持久化的用户数据，同一 Connector 可以有多个 Connection。
5. **Source 层**：Source kind 是可注册的实现，Source instance 是某个 kind 在一个 Connection 上的一份配置。Source 负责：
   - 维护读取位置
   - 定义什么算一个 Trigger
   - 丢弃自身产生的变化
   - 把外部变化翻译成 Trigger，并给出它所属的 Thread 和可回写的 Channel 地址

   首批 Source kind：
   - GitLab MR：指派给我、我是 reviewer、我创建的 MR 上的新评论
   - GitLab 流水线：关注项目中的失败流水线
   - Jira 工单：可配置的 JQL
   - 手动输入

   轮询驱动由 Source 层统一调度，带间隔、退避和 API 限流处理。Trigger 进入领域核心的入口与投递方式无关，后续接入 webhook 时，只需新增一种投递方式，复用同一个入口。
6. **forge 集成（可选增强）**：评估为 harness 的 forge 抽象实现一个基于 `glab` 的 GitLab provider，以复用 MR 详情、diff 和 MR 与 Session 绑定的 UI。forge 目前是 experimental，如果其接口不稳定，就退回到只用自己的 Connector 和 Source，不阻塞主线。
7. **主 Session 管理**：确保存在唯一一个常驻主 Session，并在重启后恢复同一个。它使用专用 agent preset：没有 bash，文件系统只读，长命令自动转后台，只挂 Dsh Manager 的主 Session 工具。主 Session 的工具对领域核心发出命令：
   - 读取 Thread 或工单
   - 提交 Decision
   - 安排派工
   - 审阅 Report（通过 / 返工 / 建后续工单）
   - 提议 Policy 或决策记录的变更
   - 标记"建议结束"

   它的模型可以单独配置，默认用 profile 的默认模型。它的所有决策都通过工具调用留在 Session 日志中，满足 harness 的"模型看到的内容都要能从日志重建"规则。
8. **执行器**：每个工单对应一个 Executor Session 和一个 worktree。worktree 建在所映射项目的仓库下；未映射的工单只做只读分析。执行器使用专用 agent preset，模型可以单独配置。并发上限可配置，默认 3。执行器通过专用工具提交 Report（进展 / 等待 / 就绪 / 受阻 / 失败 / 无需处理）和提问。DSH 重启后，被中断的派工要么恢复，要么明确标为中断。
9. **动作审批拦截**：落在执行器的工具调用层，接入 harness 的 permission、guard、interaction 机制，不依赖提示词约束（ADR-0002）。命中 Policy 中需要审批的动作类别时，在工单上生成 Approval 并挂起该调用；批准后继续，拒绝后把意见回传给执行器。
10. **调度**：Watchdog 定期检查派工超时、无进展、连续失败以及 Connection 健康状况。优先复用 harness 的 schedule 包；纯代码的定时检查放在插件自己的 effect 定时器中。
11. **Host Remote API**：一个 `@Remote` 服务，包含以下部分：
    - Connection 的增删改、依赖检测、连通性测试
    - Source instance 配置
    - 项目映射，选项来自 harness 的项目列表
    - 看板查询，包括按列分组的工单和筛选
    - 工单详情：Thread、Mandate、派工、Report、Attention、Deliverable 引用、链路关系
    - 回应 Attention：回答提问、批准或拒绝 Approval、验收通过或退回
    - 接受观察模式下的候选
    - 手动输入
    - 评估记录查询与管家实时状态（`stewardStatus`）
    - Policy 和决策记录的查看、编辑与确认
    - 团队队员、流水线、路由规则管理与 `team-config.yaml` 热重载
    - 变更推送流，供看板实时刷新
12. **客户端**：通过 slots 注册单一左侧导航入口与 5 个一级 Tab（看板 / 团队 / 策略 / 运行监控 / 设置）以及右侧工单详情栏，并为 Attention 提供角标和 toast。遵守 harness 的客户端规范：组件不接触上下文对象，文案走 locale 字典并使用 sentence case，样式用设计 token，共享控件来自 ui-primitives。Deliverable 的展示复用 harness 现有的 deliverables 和 diff 视图，以"Session id 加对话轮次"引用，不另存副本。
13. **通知出口**：用一个出口接口承载"有新 Attention、阶段推进进展"这类通知，支持 GUI 内通知与 IM（如飞书/微信）伴侣桥接。

### 关键规则

- 只有 Eval（含手动输入经过的 Eval）和主 Session 建立后续工单时才会产生工单；后续工单继承前一工单的 Mandate，范围不得扩大。
- 接单模式按 Source instance 配置：依据明确的工作默认自动接单，依据推断的工作默认只观察。
- 工单只有经人验收才算完成；外部对象结束时，只标记"建议结束"。
- 主 Session 不能直接修改 Policy 或决策记录，只能提议，由人确认后形成新的 Policy 版本。
- 配置错误要大声失败：能自行判断的在加载时报错，否则在最早能判断的时候报错，不静默跳过。
- 跨边界的不透明 id（Connection、Source instance、Trigger、Thread、工单、派工、Attention）使用 harness 的 branded 类型。

### 里程碑

- **M0 打通验证**：仓库外 bundle 安装进 profile；最小客户端页面 → 一个 `@Remote` 方法 → storage-domain 读写；验证仓库外 typert 生成和客户端注册；验证 storage-domain 能否承担副作用队列。
- **M1 对接管理**：Connector、Connection、凭据、依赖检测、连通性测试、项目映射、配置页。
- **M2 Trigger 流**：GitLab MR、GitLab 流水线、Jira 的 Source kind，轮询调度，去重，归入 Thread，Trigger 浏览页。
- **M3 主 Session 加看板**：Eval、Decision、Policy（接单部分）、接单模式、工单、Subscription 扇出、看板与评估记录页，暂不派工。
- **M4 执行器**：worktree、派工、Report、Attention（提问 / Approval / 验收）、动作审批拦截、Deliverable 展示、副作用队列与 Channel 写回。
- **M5 收尾**：审阅与返工、后续工单、"建议结束"、Watchdog、决策记录（原晨间简报项已随 2026-11-24 重构移除）。
- **团队配置 v2 与提示词工作台（2026-11-25）**：`team-config.yaml` 升级支持 `version: 2`（向后兼容 v1），在全局 `prompts.turns`、流水线 `pipeline.prompt`、环节 `stage.prompt` 三层提供按段落 ID 合并的提示词覆盖与契约段锁定；执行器下发提示词随 `DispatchRecord.prompt` 持久化在工单详情回看，管家 6 个轮次保留最近 20 份原文供运行监控页展开；团队页新增「提示词」子视图（8 个内置轮次树、只读变量目录、实时项目/工单预览、二次确认保存、YAML 导出/导入）及 3 条只读流程预设一键复制。
- **之后**：GitHub Connector、webhook 投递、IM 通知出口。

## Testing Decisions

- **好测试的标准**：只测外部可观察的行为，不测内部实现。断言的对象是 Remote API 的返回、看板呈现的状态、外部假服务收到的请求，而不是内部表结构或私有函数。测试描述行为，而不是描述"正确性"。
- **主接缝：Host Remote API。** 在测试进程中启动一个装好 Dsh Manager bundle 的 Loader 应用，复用 harness 的 `loader-smoke`。外部系统用本地 HTTP 假服务模拟 GitLab 和 Jira 的 API。模型输出用 harness 的 `llm-replay` 或 `llm-mock-server` 脚本化，不需要真实 API key。典型场景：
  - 注入流水线失败 → 看板出现工单 → 执行器要发评论 → 生成 Approval → 批准后假 GitLab 收到评论
  - 推断类 Trigger → 进入"待评估"候选 → 接受后变成工单
  - 重复拉取 → 只有一个 Trigger
  - 重启 → 读取位置和被中断的派工能够恢复
  - 返工超过两次 → 转为 Attention
  - 后续工单试图扩大范围 → 生成 Approval
  - 外部 MR 合并 → 标记"建议结束"
  - Connection 凭据失效 → Watchdog 生成 Attention
- **辅助接缝 1：领域核心。** 使用内存仓储，穷举状态机的边界情况：Eval 串行与并批、Decision 的幂等、Mandate 继承与越权、Subscription 扇出规则、派工与工单状态互不跟随、看板列的派生、Policy 版本变更、返工上限。参照原型对其领域核心的测试方式。
- **辅助接缝 2：客户端。** 使用 harness 的 `client-runtime`（jsdom slot 测试台）和 `remote-mock`，测试看板分列、筛选、实时刷新、工单详情、Attention 操作和配置页（依赖缺失提示、连通性测试结果）的渲染与交互，不启动 Host。
- **不新增其他接缝。** Connector 和 Source 通过主接缝上的假服务覆盖，不单独 mock 内部客户端。
- **跨平台**：CI 矩阵至少包含 Windows 和一个 POSIX 平台；路径、worktree 和子进程相关场景必须在 Windows 上跑过。
- **真实 API 测试**（真实 GitLab、Jira、模型）只作为手动或带凭据时才运行的 e2e，没有凭据时自动跳过，不进默认测试。

## Out of Scope

- GitHub Connector（排在 M5 之后）。
- Webhook 投递（只在数据模型和入口上预留，不实现接收端）。
- 飞书、IM、邮件等 GUI 之外的通知出口（只预留出口接口）。
- 投机执行（没人要求时在后台先做、做成了再拿出来）。
- 多用户、团队共享、权限与账号体系、任务分派给他人。
- 替用户安装系统依赖（如自动执行 `winget install glab`）。
- 自建 CI 流水线、自动合并与发布（卡兹克文章中的 CI 中台）。
- 跨 Source 的身份映射。
- 数据清理与归档（MVP 只追加，不删除）。
- 修改 harness 本身的代码。

## Further Notes

- 参考资料：卡兹克《折腾了整整1年，毫无保留地分享一下我这套Agent自动化系统》（woshipm 6487627）；DeepSeek《Super-agent 设计探索：迈向更自主的 Agent 系统》；本地只读参考副本 `dsh-superagent-prototype`（MIT），其领域文档 `docs/001-domain.md` 是术语来源。
- 已知风险：
  - 仓库外的客户端注册与 typert 生成没有官方文档，需要在 M0 尽早验证，必要时向 harness 上游求证。
  - forge 处于 experimental，接口可能变化，因此 GitLab 主线不依赖它。
  - Jira 自建实例可能禁用 Basic 认证。
- 本 spec 是本地草稿，尚未发布到 issue tracker。确认后可以发布为 dsh-manager GitLab 仓库的 issue，并打上 `ready-for-agent` 标签。发布前需要先运行 `/setup-matt-pocock-skills` 配置 tracker 和标签。
