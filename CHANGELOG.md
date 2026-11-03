# Changelog

## Unreleased

- Global skill scanning now resolves the agent roots against the platform home directory: on Windows `%USERPROFILE%` replaces a POSIX `HOME` inherited from Git Bash, and an unset or blank home no longer makes the roots current-directory-relative, which made every non-DSH root report as missing.
- The shared `.agents` root follows `DSH_AGENTS_HOME`, like the rest of the harness.
- Import containment checks compare path ancestry instead of a `/`-joined prefix, so imports work with Windows separators.

## 0.1.2

- README images and documentation links now use absolute GitHub URLs, so they render correctly on the npm package page.
- Adds the tag-triggered npm trusted-publishing workflow note and release checklist updates.

## 0.1.1

- Ship the built `lib/` and `client/` artifacts in the repository so Git installs need no `prepare` script or pnpm `allowBuilds` approval.
- No behavior changes; Git installs of `v0.1.1` or later work directly.
- Adds a tag-triggered GitHub Actions release workflow for npm trusted publishing (OIDC).

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
