# Autoloop Kernel (自动化内核)

The deterministic, zero-dependency orchestration engine that converts external signals into autonomous closed-loop agent execution with human-in-the-loop decisions.

## Language

**Kernel (内核)**:
The core deterministic state machine (~1600 lines, zero external dependencies) managing event-sourcing, task dispatching, suspension, and hop limits.
_Avoid_: Platform, framework, monolith, middle-office

**Event Plugin (事件插件)**:
A pluggable provider that ingests external occurrences (e.g. Git, Cron, business webhooks) and emits immutable Events to the Kernel.
_Avoid_: Listener, hook, trigger adapter

**Agent Plugin (Agent 插件)**:
An execution adapter (e.g. DeepSeek Harness Agent, Claude Code, Codex) that receives dispatched work from the Kernel and returns results.
_Avoid_: Runner, worker node, AI tool

**Channel Plugin (通道插件)**:
An interaction adapter (e.g. Feishu, DingTalk, Desktop notifications, Web UI) that presents human-in-the-loop decision cards and receives approval verdicts.
_Avoid_: UI frontend, message bridge, IM client

**Event Sourcing (事件溯源)**:
A persistence model where all task states are reconstructed strictly from an append-only log of immutable events without database migrations.
_Avoid_: CRUD storage, SQL tables, state dumping

**Suspension (挂起零消耗)**:
The state where an execution process exits completely while awaiting human decision, preserving conversational continuity without burning tokens.
_Avoid_: Sleeping, blocking wait, idle loop

**Hop Limit (跳数熔断)**:
A deterministic ceiling (e.g. 8 hops) on chained agent-to-agent event triggers to prevent infinite recursion and budget exhaustion.
_Avoid_: Timeout, depth check, rate limit

**Prompt-Data Separation (指令数据分离)**:
The security boundary ensuring untrusted external inputs (e.g. Issue text) remain inert data and cannot modify system prompts, directory scope, or permissions.
_Avoid_: Input sanitization, parameter escaping
