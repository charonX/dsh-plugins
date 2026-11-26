# 0009: 工单时间线由插件域账本持有，不依附 Session

日期: 2026-11-26
状态: accepted
关联: ADR-0003（域存储）、spec 0001、`scratch/tasks/2026-11-26-board-continue-after-done/align-card.md`

## 背景

工单详情此前把「对话」直接读自 Executor Session（`ticketDetail` → `messagesOf`），Session 缺失时退回 dispatch.reports。这带来三个结构性问题：

1. **记录随 Session 消失**。宿主 SessionStore 是内存表，插件重载或 DSH 重启后，历史对话、工具调用、产出与 diff 全部读不到，只剩 reports；冷恢复也不重新注入插件按 dispatch 注册的工具。
2. **不属于 Session 的事写不进去**。Steward 复核打回（`reopenStageTicket` 只把 `ended` 改回 `todo`，没有理由字段）、派工开始/取消、产出物引用，这些都没有对应的 Session 事件，时间线上天然缺失。
3. **缺少业务归属**。Session 事件是宿主扁平事件流，不携带「属于哪一轮、是人的指令还是执行器回复、对应哪个 attention」；UI 只能按 dispatch 卡片切碎展示。

产品上已确定：一张工单的执行结束后，人仍要能在同一会话里继续补指令；继续与否不改变「工单是持久对象、每次派工只是一轮」的模型。历史必须比 Session 活得久。

## 决策

**工单时间线 = 插件域里的一张账本表，Session 只是事件的来源之一。**

- 新增域表 `timelines`：一张工单一条记录（`{ ticketId, events[], updatedAt }`）。单记录原子写（ADR-0003）让 append 在同一写链里完成去重与 `seq` 分配，不需要额外计数器，也没有跨记录事务问题。
- 事件字段：`id`、`seq`、`kind`（instruction / assistant / tool / report / attention / artifact / system）、`author`（user / executor / steward / system）、`at`、`turnId`、`code`（客户端本地化的稳定机器码）、`body`（原文）、可选的 `attentionId` / `reportId` / `activity` / `backfilled`。
- 写入点：dispatch 与 attention 的**存储适配器**在写成功后就地镜像（轮次开始、每条 report、轮次结束、提问、回答）；Steward 的返工与结束由 board service 显式追加。事件 id 由来源派生（`report:<dispatchId>:<reportId>`、`attention:<id>:answered`、`dispatch:<id>:started`），重放与重启扫描天然幂等。
- 读模型：`ticketDetail` 返回 `events`；老工单首次读取时从 dispatch.reports 与 attentions 折叠回填（`backfilled: true`），id 同样派生，重复回填不产生重复事件。
- 保留策略：文本事件永久保留；工具类事件由 UI 按轮聚合成一条并折叠明细，账本本身不丢原始 report。
- 域版本升到 2，`compatibleVersions: [1]`：v1 记录 schema 未变，可读；首次写入后 unit 标记为 2。

## 后果

- 正向：历史不再依赖 SessionStore；Steward 打回理由、派工生命周期、attention 问答都进同一条线；冷恢复丢失的只是「会话记忆」，时间线不受影响；UI 可以按轮次渲染而不必重建数据。
- 负向：dispatch/attention 的写与账本写是两次写，中间崩溃会漏事件（reports 可从 dispatch 记录补，轮次开始/结束可从状态补，回答可从 attention 记录补）；适配器镜像失败默认向上抛，注入 reporter 时降级为 host 日志。账本记录随工单增长，超长工单需要端上分页（读模型分页留到 P2）。
- 中性：`ticketDetail` 的输出从「dispatch 列表 + 活 Session 消息」转向「账本 + dispatch 列表」，客户端在 P0b 切换渲染源；切换完成前两套数据并存。
- 版本：升到 2 后一旦写过账本，旧版（只认 1）打开该 unit 会 `version-mismatch`；回退插件版本会让看板无法打开，需先备份或随插件回退一起处理。

## 备选方案

- **继续读 Session，加持久化 session 日志**：宿主 SessionStore 的持久层语义不受插件控制，且 Session 事件无业务归属；否决。
- **每事件一行表**：查询要全表扫描，`seq` 需要额外计数与并发保护，收益不足以抵消复杂度；否决。
- **把账本挂在 dispatch 记录上**：dispatch 被取消/重启扫描改写时，历史会被状态机语义污染；且 Steward 事件不属于任何 dispatch；否决。
