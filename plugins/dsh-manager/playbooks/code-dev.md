---
id: code-dev
name: 通用功能开发
when: 新功能开发、模块设计、API 或 UI 改动，或需要完整调研-对齐-TDD-审查-交付闭环的任务
workspaceMode: worktree
---

# 通用功能开发 Playbook

适用于需要先行摸底与方案对齐、并通过 TDD 与独立审查交付的工程改动。

1. **只读调研** {#research} (`how`, 只读): 摸清相关模块职责、真实调用链（`file:line`）与现有约束，不修改代码。
2. **方案对齐与确认** {#align} (`align`, 只读, 需人工确认): 收敛边界、数据模型与行为级验收标准；涉界面或交互分叉先在隔离环境出可点击多态交互稿比选，经用户确认后再编码。
3. **架构锁定与测试驱动实现** {#implement} (`architect`, `tdd`, 失败重试): 先定两套边界方案选出单一状态归属与 E2E 测试接缝，再补含真链路测试的行为级红灯与最小实现，保持绿灯。
4. **实跑验证与取证** {#verify} (`verify`, 失败回退: implement): 在真实表面（CLI、页面与项目构建门禁）实跑取证。
5. **独立双轴审查** {#review} (`code-review`, 只读, 失败回退: implement): 独立核查 Spec 一致性与 Standards 风险，缺陷须带 `file:line` 与复现证据。
6. **交付准备** {#ship} (`ship-pr`): 确认 diff 清洁、无凭据泄露，整理 Summary / Before-After Evidence / Merge Danger。
