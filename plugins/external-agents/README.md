# @charonx/dsh-external-agents

Session-level third-party coding agent runtime for DeepSeek Harness (`Antigravity` via `agy acp`, `Claude Code`, `Pi Agent`, and `Codex`).

## Features

- **Clean Native Isolation**: Runs without registering placeholder `ext-*` LLM providers in `ctx.llm` or `ext-*` `AgentPreset` entries, keeping DSH's mode menu and Settings → Models clean while preserving `ctx.externalAgents` (`getCatalog`) for `dsh-manager` flow nodes and `ctx.subagents`.
- **Settings Center (`settings.section` → External CLIs)**: Inspects installed CLI availability, version, executable path, and auth summary; displays subscription quota (`agy -p "/usage"` live 5h/weekly buckets, passive Claude `rate_limit_event` windows, Codex telemetry snapshots, and explicit unsupported status for Pi); and configures the default agent for new sessions plus per-CLI default model, default reasoning effort, and custom models.
- **Composer Quick Switcher (`conversation.input.right`)**: Renders the session Agent switcher beside the composer model control, locking after the first turn starts while keeping model and reasoning effort switchable mid-conversation.
- **Single-Popover Model & Reasoning Picker**: Replaces the native model menu when an external agent is active, combining an instant reasoning effort strip (`--effort` for Claude Code, `model_reasoning_effort` for Codex, `--thinking` for Pi, ACP `thought_level` for Antigravity) with a searchable model list in a single popover.
- **Native DSH Projection**: Translates external agent thinking chunks, text deltas, and tool calls/results into DSH `agent/assistant-stream` and session events (`tool/call`, `tool/result`, `assistant/message`), supporting Web UI rendering and reloadable history.
- **Exclusive Session Guard**: Tracks active runs per DSH session and external conversation id to reject concurrent writes.
