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
      offpeakStart: '22:30'
      offpeakEnd: '06:30'
      maxConcurrent: 2
```

| Config | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Mount the kernel at all. |
| `maxHops` | `8` | Recursive agent-to-agent chain ceiling; reaching it stores the ticket as `circuit_broken`. |
| `autoWorktree` | `false` | Allocate an isolated Git worktree per ticket through `ctx.worktrees`. |
| `journalPath` | `<DSH_HOME>/autoloop/journal.jsonl` | Append-only event journal. |
| `defaultWorkspacePath` | `process.cwd()` | Fallback workspace for tickets that name none. |
| `offpeakStart` / `offpeakEnd` | `23:00` / `07:00` | Host-local `HH:mm` quiet-hours window. Equal bounds keep it open all day. |
| `maxConcurrent` | `2` | Tickets executing at once; further due tickets wait for a slot. |
| `completedRetentionDays` | `14` | Days a finished ticket stays in the journal and on the board. Active tickets are never dropped. |
| `journalCompactLines` | `2000` | Journal length that triggers a rewrite into one snapshot entry. |

## Execution Timing

A ticket carries exactly one timing decision, and every surface reads the same
values: the kernel decides admission with them, the router narrates with them,
`GET /api/autoloop/snapshot` publishes them, and the Kanban renders them.

| Mode | Start condition |
|---|---|
| `immediate` | The next admission sweep, subject to `maxConcurrent`. |
| `offpeak` | Inside `offpeakStart–offpeakEnd` **and** a free slot. Outside the window it stays queued; the board shows when the window next opens. |
| `scheduled` | At or after its committed `scheduledAt` (epoch ms) **and** a free slot. A missing or past instant is rejected with HTTP 400 instead of degrading into an immediate run. |

`nightly` remains accepted as an **input** alias of `offpeak` for external callers;
journals written before the window became configurable replay as `offpeak`, and the
alias is never stored. Admission is swept every 20s; the timer never keeps the host
process alive.

## Human Intervention

- `POST /events` — create a ticket (`payload.scheduleMode`, `payload.scheduledAt`).
- `GET /snapshot?doneLimit=&doneOffset=` — board state. `stats` covers every ticket, `active` returns all unfinished work, `done` is one page of finished tickets (`doneTotal` is the unpaged count), plus the configured window (`offpeak`) and dispatch ceiling (`limits`). `doneLimit` is clamped to 1–500 and defaults to 100; malformed bounds fall back to the defaults.
- `POST /tickets/run-now` — start a pending, failed, or circuit-broken ticket immediately without rewriting its timing plan.
- `POST /tickets/retry` — requeue one failed or circuit-broken ticket (HTTP 409 when it is not retryable).
- `POST /tickets/schedule` — change a queued ticket's mode/instant (`scheduleMode`, `scheduledAt`); HTTP 400 for an unusable timing, 409 for a ticket that is not queued.
- `POST /attention/resolve` — answer a pending Attention and resume the agent.

A ticket left `running` by a crash is requeued when the executor mounts, so an
interrupted run cannot occupy a slot forever.

## Journal, Retention, and Compaction

The journal (`<DSH_HOME>/autoloop/journal.jsonl`) is append-only during normal
operation: every state change is one JSON line, and boot replays the file to
rebuild memory. Two bounds keep that from growing forever:

- **Retention.** A finished ticket (`completed`, `failed`, `circuit_broken`) is
  kept for `completedRetentionDays` (default 14) after its last change. Tickets
  that are `pending`, `running`, or `waiting_attention` are never dropped.
- **Compaction.** When the log reaches `journalCompactLines` (default 2000), or
  when expired history is still present, the store rewrites the log as a single
  `snapshot` entry holding every retained ticket and renames it over the old
  file. A failed rewrite keeps the previous log and logs a warning; a `snapshot`
  line is a baseline, so replay clears state before loading it.

Two durability rules: an append writes to disk **before** it applies to memory,
so a failed write throws and leaves state unchanged; and an undecodable line is
counted (`corruptLineCount`) and warned about rather than silently skipped.

Because finished tickets are bounded, `GET /snapshot` pages them instead of
returning the full history: the board loads 100 at a time (up to 500) and keeps
loaded pages across polls.

## Plugin Ports & Integration

The kernel exposes three clean, decoupled extension points:

- **Ingress Events**: Call `ctx.autoloop.ingestEvent(event)` from any event source.
- **Agent Executors**: Register an execution adapter via `ctx.autoloop.registerExecutor(adapter)` (defaults to dsh native `ctx.agents`).
- **Approval Channels**: Register notification bridges via `ctx.autoloop.registerChannel(channel)` (e.g. Feishu interactive card bridge).

## License

MIT © charonX
