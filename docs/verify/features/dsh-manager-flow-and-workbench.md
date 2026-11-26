# Dsh Manager 流程编排与工单工作台

## Sub-features

- Schema v3 Flow IR 与「一次识别、Hash 缓存」Playbook 编译器（`playbook-compiler.ts`），支持从 `skills/playbooks/*.md`、工作区 Skill 或内置默认 `playbooks/*.md` 编译与自动首装
- 宿主 `ctx.skills` 与多目录 Skill 聚合（`workspace-skills.ts`）以及无命中流程时的单步通用执行兜底（`steward-service.ts`）
- 工单域账本（`timelines` 表，`board-domain.ts` v2 `compatibleVersions: [1]`）独立持有事件流与 `TicketView.lastActivity` 看板卡片摘要
- 工单工作台抽屉（`TicketDetail.tsx`、`TicketTimeline.tsx`、`TicketComposer.tsx`）与 `continueTicket` 同一 Executor Session 续做（`executor-service.ts`）

## How to get to it (user POV)

1. 进入左侧栏 `dsh-manager` 面板 → `团队与流程`，切换「流程编排 / 可用技能」查看自动编排与从 Playbook 导入、从预设复制流程。
2. 进入 `看板`，点击工单卡片打开右侧「工单工作台」抽屉，浏览按轮次折叠的对话时间线与「最近活动」卡片摘要，并在底部输入区直接派工、运行中追加指令或对 `ended` 工单发起「继续」。

## Driving it

- 单元测试与编译器门禁：`pnpm --filter @charonx/dsh-manager test`（`tests/unit/playbook-compiler.spec.ts`、`tests/unit/workspace-skills.spec.ts`、`tests/unit/prompt-builder.spec.ts`、`tests/timeline/timeline-core.spec.ts`、`tests/timeline/storage-store.spec.ts`）。
- 客户端与 Boot 集成：`tests/client/flow-workbench.client.spec.ts`、`tests/client/board.client.spec.ts`、`tests/boot/steward-auto-advance.boot.spec.ts`。
- 真实 Web 页面 E2E：`pnpm --filter @charonx/dsh-manager e2e`（详见插件内 [plugins/dsh-manager/docs/verify/README.md](../../../plugins/dsh-manager/docs/verify/README.md)）。

## Gotchas

- `team-config.yaml` 保存在 `<DSH_HOME>/dsh-manager/team-config.yaml`，清空为 `flows: []` 后重启不会强制覆写回默认 Flow，而是走单步通用兜底。
- `ended` 工单的同会话续做通过 `ctx.agents.resume` 接续原 `sessionId`；当宿主会话因进程重启不可恢复时，需显式提示或通过 `newSession` 新开会话，时间线账本不受影响。
