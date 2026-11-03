# Changelog

## 0.1.0

First public release.

- Skill library with Git and local sources; install jobs with live command output.
- Version labels (`package.json`, then `git describe --tags --always --dirty`) and Git update checks (`behind`/`ahead`/dirty/upstream label), explicit `git pull --ff-only` updates.
- Project distribution by symlink into 75 agent conventions plus `dsh`; multi-project linking, per-project switches, per-skill linking, resync, conflict protection, and cascade removal.
- Two switch levels: library master switches and per-project distribution switches.
- Scan globally installed skills (DSH, Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Windsurf, shared agents) and import them as `imported-<origin>` sources with hash-based conflict handling and provenance in `imports.json`.
- Skills page in the Harness sidebar with collapsible sources/projects, expand-all controls, search, and zh/en copy.
- HTTP API under `/dsh-skills-manager`, same-origin write protection, Git transport allow-list, no shell execution.
- Unit/integration suite (88 tests), overlay and profile verification scripts, and local debugging tooling.
