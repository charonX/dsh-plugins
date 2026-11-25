# ADR-0004: 放弃 forge GitLab provider（可选增强不落地）

日期：2026-11-13
状态：已接受
关联：spec 0001 实现决策"forge 集成（可选增强）"；票据 25（可选：forge GitLab provider 评估）

## 背景

spec 0001 提供了一个可选增强：基于 `glab` 实现一个 GitLab 的 forge provider，接入 harness 的 forge 抽象（`@deepseek-ai/dsh-experimental-forge`，`ctx.forge`），以复用 forge 现有的 MR 详情、diff、MR 与 Session 绑定的 UI。forge 目前位于宿主的 `packages/experimental/`（forge / forge-github / forge-session / client-ui-forge / forge-bundle）。

dsh-manager 的 GitLab 主线不依赖 forge：Trigger 收集（MR opened/merged/closed、流水线、notes）由自己的 poller 通过 Connection 记录实现（票据 10/21），工单详情的 MR 链接与 diff 也走自有实现。

## 评估结论：放弃

### 1. 凭据模型冲突（决定性）

forge 的 `ForgeProvider` 接口没有任何凭据/地址参数化：每个 forge family 只注册一个 provider（`register` 对重复 family 直接抛错），认证来自环境里的 CLI 自带凭据库——forge-github 明确"token 永不进入子进程环境，`gh` 用自己的凭据库认证"。而 dsh-manager 的 Connection 模型是**多连接、每连接独立 baseUrl 与 PAT**（自建 GitLab server-dc/cloud 均支持），PAT 只允许存放在 harness credentials store 的 `dsh-manager/conn-<id>` 键下。

要让 glab provider 使用某个 Connection 的凭据，只有两条路，都不可接受：

- 把 PAT 写进 glab 自己的配置/凭据库（`glab auth login --token`）——凭据被复制到 harness credentials store 之外，违反安全约束（PAT 不得出现在日志或配置文件中）；
- 每次调用向子进程注入 token 环境变量——与 forge-github 的既有设计（scrubbed parent env、禁止 token 进环境）直接冲突，等于重写 provider 的安全模型。

多连接自建 GitLab 的场景在 forge"一 family 一 provider + 环境级认证"的模型下无法表达。

### 2. 稳定性风险

forge 全部位于 `packages/experimental/`：按 experimental 政策，"完整公共能力仍在评估中，不构成产品支持承诺；行为或 API 可能变化，能力可能被撤回"。`ForgeProvider` 接口面很大（约 30 个方法：fetch、diff、commits/compare、review 读写、viewed 标记、checks rerun、branch update、reviewer 请求等），全量实现 glab 版本是一笔大投入，落在一个明确可能变更的契约上。

### 3. 收益有限

forge 能带来的是 MR 详情/diff/评审 UI 与 Session 绑定（forge-session + client-ui-forge + forge-bundle，默认关闭、需显式启用并要求 Session 的 git checkout/worktree 绑定）。dsh-manager 已有的工单详情（deliverable 引用、变更 diff、MR 外链跳转）覆盖了主线需求；MR 评审类 UI 是锦上添花，不构成引入不稳定依赖的理由。

## 决策

1. **不实现** forge GitLab provider；GitLab 主线继续走 dsh-manager 自己的 Connection + poller 路线，不依赖 forge。
2. dsh-manager 不引入 `@deepseek-ai/dsh-experimental-forge` 依赖。
3. 若未来 forge 转为产品级且 provider 接口支持按连接注入凭据（provider 可携带 per-connection 身份），可重新评估；届时本 ADR 作废并以新决策取代。

## 后果

- 票据 25 以"记录结论并放弃"路径关闭。
- 工单详情中的 MR 链接继续使用 web_url 外链（现状），不接入 forge 的 MR 视图。
- 无代码变更，无测试影响。
