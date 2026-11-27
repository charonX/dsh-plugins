# ADR 0010：工单续做走同一 Executor Session

- 状态：已采纳（2026-11-26）
- 相关：ADR 0009（工单时间线账本）、`docs/specs/0001-dsh-manager.md` 故事 86–90

## 背景

旧实现里，工单一旦 `ended` 就四条路同时关死：领域层把 `ended` 当终态且没有对外的
reopen；`deliverAnswer` 只在 dispatch `running` 时才会 followup；每次派工新铸
`dsh-manager-exec-<dispatchId>` 会话、工具闭包绑死单条 dispatch；界面上也没有输入位。
结果是任务做完之后，人无法在同一个会话里接着说一句话。

## 决策

1. **一个入口**：新增 `continueTicket({ticketId, text, newSession?})`，语义由工单状态决定，
   不再按「评论 / 重试 / 返工」分成多个动作。
   - `running` 且有活 agent：`followup` 送达当前轮，记为 `sent`。
   - `running` 但没有活 agent（外部 CLI 或崩溃残留）：排一条带 `resumeOf` 的派工，记为 `queued`。
   - `ended`：先把工单拉回 `todo`（`reopenStageTicket`，附原因与作者），再排一条带原
     `sessionId` 与 `resumeOf` 的派工。
   - `todo`：先查未解依赖，再按有无历史会话决定 `started` 还是 `resumed`。
2. **同一会话靠 resume，不靠 keep-alive**：派工记录带 `sessionId` 与 `resumeOf`；执行器启动时
   先 `dispose()` 前一条派工的活 handle，再 `ctx.agents.resume({ resumeSessionId, setup })`，
   由新的 `setup` 把 `report` / `ask` / 审批门重新绑到当前派工上。
3. **一会话一活 agent**：`pump` 发现同一 `sessionId` 上已有别的 `running` 派工时跳过本轮，
   避免 `SessionAlreadyOwnedError`。
4. **失败要明说**：resume 失败记 `failed` 报告，绝不静默新开会话；`newSession: true` 是显式的
   用户选择。
5. **取消是轮次动作**：复用既有 `dispatchCancel`，账本记 `turn-ended:interrupted`。

## 备选与否决

- **保持每次派工新会话**：上下文断裂，人每次都要重新交代背景，正是要解决的问题。
- **复用宿主侧栏会话**：侧栏作用域是 session，看板是 root，且插件按派工注入的工具在冷恢复里
  不会重新注册；只能看能聊，不能把产出写回工单。
- **常驻不销毁 agent**：宿主内存会话在插件重载与进程重启后消失，且一会话只能有一个活 agent。

## 后果

- 续做能真正接上上下文；代价是 resume 前必须 dispose 旧 handle，挂载成本与 prompt cache 会重建。
- 会话随工单越积越长，需要 compaction 策略（当前交给宿主，后续在预算超限时提示新开会话）。
- 账本写入与派工写入是两次写：靠稳定事件 id 幂等、失败只记日志，不阻塞派工本身。
