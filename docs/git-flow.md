# Git Flow 与分支交付规范（dsh-plugins）

本仓库（`charonX/dsh-plugins`）采用 **PR 受保护主干 + 独立测试集成分支 + 语义化特性分支** 工作流，适用于人工日常开发以及 `dsh-manager` 等自动化 Agent 交付流程。

## 1. 分支模型与权限边界

| 分支 | 定位 | 合入权限与方式 |
|---|---|---|
| `main` | 唯一稳定主干与发布基线 | **受 GitHub 分支保护，仅允许通过 GitHub PR 合并。** 严禁任何本地直接 `git push origin main` 或执行 `local_merge_branch(targetBranch: "main")`。 |
| `test` | 集成测试与联调验证分支 | 接收开发完成后、已通过本地插件门禁的 `feat-*` / worktree 分支本地合并（`local_merge_branch(targetBranch: "test")`）。在 `test` 上完成集成实测与人工验证。 |
| `feat-*` | 单功能/单工单开发分支 | 从最新的 `main`（或需要联调的 `test`）拉出，在独立工作区或 `git worktree` 中开发并提交。 |

## 2. 分支命名规范

- 特性开发分支统一以 **`feat-`** 开头，使用英文小写与短横线（kebab-case），名称必须直观体现所属插件与具体功能：
  - 通用格式：`feat-<plugin>-<feature-summary>`
  - 示例：`feat-dsh-manager-watchdog-heartbeat`、`feat-external-agents-session-guard`、`feat-skills-manager-export`
- 修复类需求可使用同一前缀体现修复目标（如 `feat-dsh-manager-fix-worktree-group`），或遵循团队约定以 `feat-` 开头保持一致。
- 若存在 `dsh-manager` 既有工具创建的历史 `dsh-manager/<ticket-id>` 分支，可在对应工单延续使用；新建特性分支与提交 PR 时优先以 `feat-<plugin>-<feature-summary>` 命名。

## 3. 标准开发与交付流程

### 第一阶段：需求对齐与分支隔离开发（Worktree / 特性分支）
1. 确认目标插件与改动范围，从基线分支拉出 `feat-<plugin>-<feature-summary>` 分支（并行任务优先使用 `.dsh-worktrees/` 独立 worktree，避免污染主目录）。
2. **禁止混仓提交**：`deepseek-harness/` 为独立上游 Git 仓库，严禁从本仓顶层修改或提交 `deepseek-harness/` 内的任何内容。
3. **禁止入库物**：`node_modules/`、`lib/`、`dist/`、`coverage/`、`*.log`、`.env*`、`.dsh-manager/`、`plugins/*/pnpm-lock.yaml` 与临时排查文件严禁纳入 Git 提交。
4. 按约定格式撰写简洁清晰的 Commit Message（建议 `<type>(<plugin>): <summary>`，如 `feat(dsh-manager): add activity-based stall detection`）。

### 第二阶段：插件门禁验收与合并到 `test`
1. 在特性分支 / worktree 内完成改动后，提交代码前必须先跑通目标插件全套本地门禁：
   ```sh
   cd repos/dsh
   ./check-plugins-against-harness.sh <plugin-name>
   ```
   跨插件或公共脚本改动须跑全量 `./check-plugins-against-harness.sh`。
2. 门禁全 `PASS` 后，**仅可合并到 `test` 分支**进行集成测试：
   - 自动化交付环节（如 `dsh-manager` 第 4 阶段）：调用 `check_branch_rebase(targetBranch: "test")` 检查冲突后，经人工 Approval 确认执行 `local_merge_branch(targetBranch: "test")`，**禁止**指定 `targetBranch: "main"`。
3. 将改动部署/联调至真实环境（如 `dsh web` 或 Desktop）做端到端人工验证。

### 第三阶段：人工发起 PR 并合并入 `main`
1. 在 `test` 分支集成测试全部通过后，由**人工确认并发起 PR**（从已验证分支 / `test` 向 GitHub `main` 提起 Pull Request）。
2. 在 GitHub PR 页面核对 diff、确认 CI / 门禁结果无误后，由**人工点击合并**进 `main`（合入后注意及时清理已完成的临时分支与 `.dsh-worktrees/`）。
3. 自动化 Agent 在任何阶段**不得绕过人工确认**擅自向远端强制推送或合入 `main`。
