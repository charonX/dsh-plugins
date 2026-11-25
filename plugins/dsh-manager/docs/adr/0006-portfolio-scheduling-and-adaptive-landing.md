# 0006: 多工单并行调度与自适应代码落地

日期: 2026-11-24
状态: accepted
关联: ADR-0002（动作级 Approval）、ADR-0003（领域存储）、ADR-0005（团队 YAML 热更新）

## 背景

随着 `dsh-manager` 同时并行运行多条开发/修复流水线，出现两类失控问题：

1. **并行 vs 冲突/重复缺乏全局约束**：新 Bug 或新需求入列时，无法感知同仓库在途或刚完结工单（例如 `briefing` 模块正被清理或刚删掉，下游又来了 `briefing` 缺陷工单，或者两个工单会同时改动同一文件），容易造成重复派工或各自改乱；
2. **代码合并与落地无串行保护与仓库适配**：各个业务仓库的 gitflow（直接本地合入 `main` vs `push` + GitHub PR / GitLab MR vs 自有 `/ship-*` Skill）完全不同，不能用静态 `projects:` 配置文件硬编码，同时也需要防止并发合入/rebase 竞态或把 worktree 卡死在冲突状态。

## 决策

### 1. 全局组合感知收敛在 Steward + `/align`，不新增「开发主管」角色

- 新增纯函数 `portfolio-context.ts`，按 `projectId` 过滤收集在途（`todo`/`running`/`attention`）与近期已完结（`ended`）工单摘要，注入 Steward Eval 与 Route 提示词，以及 `/align` 的事实排查步骤；
- Steward Eval 识别到重复或已被在途/近期完结工单覆盖的线索时，可给出 `action: "ignore"` 并记录 `supersededBy`；
- Steward Route 仅在两张工单会冲突或存在明确先后依赖时写入 `dependsOn`，其余独立工单默认并行推进。

### 2. 确定性依赖门控与同列等待视图（不新增看板列）

- `TicketRecord` 增加可选 `dependsOn?: string[]` 与 `supersededBy?: string`，并由纯函数 `dependency-core.ts` 做缺失目标、自依赖与有向图环校验；
- 确定性阻塞逻辑由 `Executor.dispatchTicket()` 与 `Executor.pump()` 强制执行；任意工单 `finishTicket()` 进入 `ended` 时立刻唤醒 `pump()`；
- 看板 UI 保持 6 列不变，被阻塞工单停留在 `todo` 列并显示语义化橙色徽章「等待前置（N）」，详情侧边栏支持跳转、增删依赖或人工一键「解除等待 / 立即并行」。

### 3. 自适应仓库落地发现与安全串行执行

- 新增 `landing-discovery.ts`：派工到受管仓库时动态探测目标仓及祖先目录 `AGENTS.md` / `CLAUDE.md` / `docs/verify/README.md`、项目局部 `.agents/skills` / `.claude/skills` 里的 PR/发布 Skill、当前分支、远端 `origin`（GitHub / GitLab / 无远端）与基线分支，**不设静态 `projects:` 配置**；
- 新增 `landing-ops.ts` 与受 `Approval` 门禁保护的执行器工具：
  - `check_branch_rebase`（只读无损冲突探测）
  - `local_merge_branch`（`merge-mr` 审批类）
  - `push_branch`（`push-branch` 审批类，禁止裸 `--force`）
  - `create_mr_or_pr`（`open-mr` 审批类，调用 `gh` / `glab`）
- `withProjectLandingLock` 按 `projectId` / `repoRoot` 对同一仓库的 rebase/merge/push 做进程内串行互斥；
- Rebase 或 merge 冲突时立即 `git rebase --abort` / `git merge --abort`，干净返回冲突文件清单供打回重做；
- 当仓库 `AGENTS.md` 与项目 Skill 均未声明落地规范或存在歧义时，保守兜底为 `manual`：保持代码已验证停留在当前 worktree 分支并上报简报由人决策，绝不擅自改 `main` 或强推。

## 后果

- 维持 `Main Session (Steward)` 作为单一语义编排口，未引入额外角色协调开销；
- 依赖阻塞与同仓合并串行均由宿主确定性保障，不依赖提示词自律；
- 新增项目或变更 gitflow 时，只需维护对应仓库自己的 `AGENTS.md` 与项目 Skill，无需同步改 `dsh-manager` 配置。
