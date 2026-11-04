# dsh-autoloop

> **Autoloop Microkernel and Monitor for DeepSeek Harness.**
> A deterministic, zero-dependency orchestration engine (~1600 lines) with event sourcing, zero-cost suspension, prompt-data separation, hop limit circuit breaker, and live Kanban UI.

## Overview

Traditional agent systems bind human attention to active chat windows and risk Git concurrency collisions when multiple agents edit the same repository simultaneously.

`dsh-autoloop` provides a clean **Microkernel Architecture**:

```
                       ┌────────────────────────────────────────┐
                       │          Autoloop Microkernel          │
                       │ (~1600 lines · Zero Dep · Deterministic)│
┌──────────────┐       │                                        │       ┌──────────────┐
│ Event Plugins│ ────▶ │  1. Rule Dispatch & Thread Merge       │ ────▶ │ Agent Plugins│
│(Git/Cron/IM) │       │  2. Zero-Cost Suspension (Halt & Wake) │       │(dsh / Claude)│
└──────────────┘       │  3. Event Sourcing (JSONL Journal)     │ ◀──── └──────┬───────┘
                       │  4. Prompt-Data Separation (Security)  │     Result   │
                       │  5. Hop Limit Circuit Breaker (<=8)    │              │
                       └───────────────────┬────────────────────┘              │
                                           │ Attention Question                │
                                           ▼                                   ▼
                               ┌──────────────────────┐               Closed-loop next
                               │   Channel Plugins    │               pipeline step
                               │ (Feishu/Desktop/Web) │
                               └───────────┬──────────┘
                                           │ Verdict
                                           ▼
                                      [ Human ]
```

## Core Mechanisms

1. **Zero-Cost Suspension (挂起零消耗)**:
   When an agent encounters a high-stakes decision, it raises an `Attention`. The kernel suspends active turns without burning compute or tokens. When a human approves on Feishu or the Web UI, execution resumes seamlessly at the breakpoint.
2. **Event Sourcing (事件溯源)**:
   The state machine is driven by an append-only journal (`$DSH_HOME/autoloop/journal.jsonl`). On reboot or plugin upgrade, the memory state is reconstructed by replaying the log. Zero database migration, zero data loss.
3. **Thread Deduplication & Fan-Out (同一件事自动合并)**:
   Subsequent comments, follow-up clarifications, or attachments on the same conversation thread are fanned out directly to the active Ticket as supplemental inputs rather than spawning conflicting duplicate workers.
4. **Prompt-Data Separation (指令数据分离)**:
   Untrusted external input (e.g. GitHub issue body or chat messages) is strictly isolated inside a structured read-only data block, preventing prompt injection attacks from overriding system instructions or workspace boundaries.
5. **Hop Limit Circuit Breaker (跳数熔断)**:
   Chained agent-to-agent feedback loops increment a `hopCount`. If recursive triggers exceed the ceiling (default 8), the ticket is immediately halted to prevent runaway token expenditure.
6. **Built-in Monitor UI (前端监视器看板)**:
   An integrated Web Client tab providing:
   - 4-column Kanban: `Pending` ➜ `Running` ➜ `Attention` ➜ `Done`.
   - Direct manual task creation modal.
   - One-click human approval / rejection of pending Attention questions.

## Installation & Configuration

Add to your DeepSeek Harness profile's `cordis.patch.yml`:

```yaml
- insert:
    id: autoloop
    name: '@charonx/dsh-autoloop'
    config:
      enabled: true
      maxHops: 8
      autoWorktree: false
```

## Plugin Ports & Integration

The kernel exposes three clean, decoupled extension points:

- **Ingress Events**: Call `ctx.autoloop.ingestEvent(event)` from any event source.
- **Agent Executors**: Register an execution adapter via `ctx.autoloop.registerExecutor(adapter)` (defaults to dsh native `ctx.agents`).
- **Approval Channels**: Register notification bridges via `ctx.autoloop.registerChannel(channel)` (e.g. Feishu interactive card bridge).

## License

MIT © charonX
