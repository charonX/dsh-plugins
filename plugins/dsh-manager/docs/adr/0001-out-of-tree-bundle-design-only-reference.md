# 外置 bundle，原型只参考设计，术语沿用原型

Dsh Manager 做成 DeepSeek Harness 仓库之外的 bundle，通过 profile 安装进 dsh web/desktop，不 fork harness，这样 harness 升级时不会产生合并冲突。DeepSeek 官方的 `dsh-superagent-prototype`（MIT）解决了同类问题，但不直接依赖或复制它的代码，只参考其设计，从头编写。原因有四点：它锁定在旧版 harness（`0.2.1-alpha.2`）和 cordis（`4.0.5-alpha.1`）；它只支持 POSIX（依赖 tmux、`fcntl`、`sh`）；它写死了单个 GitHub 仓库的假设；它没有持久的任务池，审批只发生在接单时。我们沿用原型的领域术语（Trigger、Thread、Eval、Ticket、Mandate、Assignment 等，见 `GLOSSARY.md`），以便与官方文章和原型对照。

## Considered Options

- 复制原型的 `src/core`、effect/outbox 队列和来源接口再改造：可以省掉领域引擎的初始工作，但要先剥离 POSIX 和 GitHub 的耦合，还会继承它的模型约束。
- fork 整个原型：耦合最深，成本最高。

## Consequences

- 必须全平台兼容（Windows、macOS、Linux）：子进程、路径和 worktree 准备都走 harness 的 `subprocess` 和 `shell`，不依赖 tmux 之类的平台专属工具；常驻进程由 dsh web/desktop 本身承担。
- 在仓库外注册客户端 UI 和生成 typert 都没有正式文档，需要在 M0 阶段先做打通验证。
