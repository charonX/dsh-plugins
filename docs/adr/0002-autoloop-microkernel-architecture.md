# 0002. Autoloop Microkernel Architecture

We pivot from a monolithic automation hub to a minimal, deterministic Autoloop Microkernel (~1600 lines, zero external dependencies), strictly separating kernel orchestration from Event, Agent, and Channel plugins.

## Context

Prior designs risked bloat by attempting to bundle UI kanbans, specific IM adapters (Feishu/Slack), complex databases, and concrete runner implementations directly into the core hub. This violates DeepSeek Harness's "everything is a plugin" philosophy and creates tight coupling.

## Decision

The core plugin (`dsh-autoloop`) will strictly implement the **Autoloop Kernel**:

1. **Kernel Responsibilities (Internal Only)**:
   - **Deterministic Dispatch & Merge**: Maps events to targets, merges concurrent thread inputs.
   - **Zero-Cost Suspension (挂起零消耗)**: Fully unloads/halts active turns when waiting for human approval; zero token burn while idle, resumes seamlessly upon decision.
   - **Event Sourcing (事件溯源)**: Pure append-only log; state is reconstructed from events on boot, eliminating database migration headaches.
   - **Prompt-Data Separation (指令数据分离)**: Untrusted payload data (e.g. issue text) is isolated from prompts and cannot escalate permissions or alter execution directories.
   - **Hop Limit Circuit Breaker (跳数熔断)**: Halts recursive agent chains at a hard ceiling (default 8) to prevent runaway token exhaustion.
   - **Closed-Loop Feedback**: Drives self-continuation, scheduled re-checks, and downstream step triggering.

2. **Pluggable Boundaries (Interfaces Only)**:
   - **Event Plugins (In)**: Provide raw events (GitHub, Cron, Sentry, etc.).
   - **Agent Plugins (Out - Work)**: Adapters to run work (dsh native agents, external CLIs).
   - **Channel Plugins (Out/In - Approval)**: Human-in-the-loop delivery (Feishu cards, Desktop notifications, Web UI).

## Consequences

- The kernel remains tiny, deterministic, rock-solid, and easily testable without mocks.
- Any IM tool (Feishu, DingTalk, Slack) or UI surface can be swapped in or out via standard Cordis extension points without touching kernel code.
