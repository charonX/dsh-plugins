# @charonx/dsh-external-agents

Session-level third-party coding agent runtime for DeepSeek Harness (`Antigravity` via `agy acp`, `Claude Code`, `Pi Agent`, and `Codex`).

## Features

- **Composer Quick Switcher**: Renders directly beside the model selector in `conversation.input.right`.
- **Reasoning Effort Parity**: Each `ext-*` route advertises its CLI's selectable effort levels, so the composer model menu shows the same "推理等级" (Effort) row native models get. The chosen effort reaches the CLI as `--effort` (Claude Code), `model_reasoning_effort` (Codex), `--thinking` (Pi), or the ACP `thought_level` config option (Antigravity).
- **Session Agent Lock**: Allows selecting an agent only before the first turn starts; once started, the session locks its agent while model selection remains switchable within that agent's provider (`ext-agy`, `ext-claude-code`, `ext-pi`, `ext-codex`).
- **Native DSH Projection**: Translates external agent thinking chunks, text deltas, and tool calls/results into DSH `agent/assistant-stream` and session events (`tool/call`, `tool/result`, `assistant/message`), supporting Web UI rendering, Feishu (`dsh-im`) streaming cards, and reloadable history.
- **Shared Runtime**: Registers `ext-*` `AgentPreset` entries (for IM/Web preset selection) and `ctx.subagents` providers using the same adapters.
- **Exclusive Session Guard**: Tracks active runs per DSH session and external conversation id to reject concurrent writes.
