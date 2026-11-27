# ADR 0011：派工提示词设 8,000 字符硬预算，超限失败而非截断

- 状态：已采纳（2026-11-27）
- 相关：ADR 0008（skill-driven flow IR and thin steward）、ADR 0007（prompt 模板分层，已被本决策取代的路径）

## 背景

实测一张待办工单的派工提示词 **21,545 字符 / 31,510 字节**，其中工单专属内容只有约 2,209 字符（10.3%）：

| 段落 | 字符 | 占比 | 性质 |
|---|---|---|---|
| landing（工作区事实 + 文档正文摘录） | 10,849 | 50.4% | 与工单无关 |
| skills（全部可用技能清单） | 4,188 | 19.4% | 与工单无关 |
| projectIndex（再注入一份 AGENTS.md 摘录） | 2,537 | 11.8% | 与 landing 重复 |
| handoff（AC + 对话原文） | 1,423 | 6.6% | 含 assistant 整段回复 |
| artifacts | 1,056 | 4.9% | 同一错误路径重复 6 次 |
| 固定骨架其余 7 段 | 1,448 | 6.7% | 路径与 ID 填空 |

同一份 `AGENTS.md` 正文（4,491 字节）在一条提示词里出现 **5 次**——worktree 的 `AGENTS.md`、
它的软链 `CLAUDE.md`（`realpath` 相同但按路径去重失败）、祖先 `home-repos` 的两份、以及
`projectIndex`。同时 `MAX_RENDERED_PROMPT_BYTES = 65_536` 远大于实际用量，超限时还会静默截断尾部，
既有上限既拦不住冗余，也掩盖了裁减需求。

## 决策

1. **只保留工单专属内容 + 指针**：删除 `projectIndex` 段与 landing 的文档正文摘录；仓库规则改为一行
   `Repo rules: read <path> before acting; they are not inlined in this prompt.`——执行器自己的 agent
   运行时已按 cwd 注入 `AGENTS.md`，Claude / Codex / Antigravity 等外部 CLI 也会自读。
2. **技能段只列本次挂载**：`formatSkillPromptLines` 只输出 flow 当前步骤挂载的技能与其 `SKILL.md` 路径；
   agent 自身 catalog 已覆盖其余可用技能，"Other available skills" 整块删除。
3. **软链按 `realpath` 去重**：`readDocExcerpts` 用 `realpathSync` 归一后再判重，`CLAUDE.md → AGENTS.md`
   只读一次。
4. **预算 8,000 字符、超限失败**：新增 `MAX_DISPATCH_PROMPT_CHARS = 8_000`；渲染后按段落统计
   （`sectionSizes`），超限抛 `PromptBudgetExceededError`，执行器写一条 `failed` 汇报并开一条带段落明细的
   attention。**不静默截断**——截断后的提示词看起来正常却缺少关键契约，比直接失败更难排查。
5. **预算是字符不是字节**：模型上下文按 token ≈ 字符计，按字节估算会让中文段落被低估三分之一。
6. **只管派工路径**：管家轮次仍用 `MAX_RENDERED_PROMPT_BYTES` 字节截断；两者互不影响。
7. **顺带修 artifacts 路径**：`scratchDir` 是相对路径（`home-repos/scratch/tasks/<slug>`）时按 scratch 根锚定，
   不再与 workspace 基路径二次拼接（`home-repos/home-repos/...`）。

改造后同类工单预算约 **3,300–3,800 字符**，降幅约 83%。

## 备选与否决

- **恢复三级可视化 Prompt Studio 模板层**（ADR 0007 的实现）：已按 ADR 0008 收敛为极简拼装器，用户不需要
  逐段配置，需要的是"别把无关内容塞进来"。
- **提高字节上限并保留截断**：治标；尾部截断会切掉 locked 契约段（`scope` / `report` / `approval`），
  正是最不能丢的部分。
- **按 token 精确计量**：需要引入 tokenizer 依赖，且不同 provider 计数不同；字符上限作为安全阀足够。
- **只删 docs 摘录、保留 projectIndex**：`projectIndex` 与 landing 同源，单独保留仍是重复注入。

## 后果

- 派工提示词回到工单本身，缓存命中与排查成本都下降；超长 mandate 会在派工前暴露为一条可读的失败，
  而不是静默降级。
- 代价：agent 需要自己读一次 `AGENTS.md`（一次工具调用），换来的是提示词里不再有五份副本。
- resume 场景下多轮叠加仍可能撞限，这是设计意图：应当拆票或精简 mandate，而不是把预算调大。
- 存量工单需要迁移：新增 `dsh_manager_revise_ticket` 只管 `todo` 态，改写 title / scope / AC / scratchDir /
  worktree 计划，并落一条 `revised` 时间线事件。
