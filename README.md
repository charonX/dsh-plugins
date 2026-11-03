# dsh-skills-manager

A **skill library manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**. It installs skill sources from Git or a local folder, keeps them updated, lets you switch individual skills on or off, and distributes them into projects as symlinks — for DSH itself and for the other coding agents a project uses. Everything is available on a dedicated **Skills** page in the Harness sidebar, next to Plugins and Automation tasks.

Skills managed here are real Harness skills: they appear in the model's `skill` tool catalog and in the composer's `/` suggestions without any extra wiring.

```
$DSH_HOME/skills-manager/
├── library/                 # one directory per installed source
│   ├── owner-repo/SKILL.md                      # single-skill source
│   ├── other-repo/skills/<name>/SKILL.md        # multi-skill source
│   └── other-repo/skills/<category>/<name>/SKILL.md   # nested category layout
├── manager-state.json       # enable flags, categories, notes (sparse)
├── links.json               # per-project link intent (agents + skills)
└── updates.json             # last git update check per source
```

## Requirements

- Node.js ≥ 24.9
- DeepSeek Harness `0.2.1-rc.5` or newer (`engines.dsh` is `>=0.2.1-rc.5 <0.3.0`; tested on `0.2.1-rc.5` and `0.2.2-alpha.2`)
- `git` on `PATH` only for Git sources; local-folder sources work without it

## Install

Into a Harness profile (a linked checkout while developing):

```sh
dsh plugin --profile web add /path/to/dsh-skills-manager
dsh --profile web --dump-config    # should show a "# == dsh-skills-manager" layer
dsh --profile web
```

As a profile bundle. Use a **linked checkout** while developing and a **tarball** only to validate the published package (`files`, `prepack`, no sources); both are one command for `dsh plugin add`:

```sh
dsh --profile skills-test --from-default-profile web --dump-config >/dev/null   # create profile, no boot

# development: the profile links this checkout (build first)
pnpm run build
dsh plugin --profile skills-test add "$PWD"

# release check: only what npm would ship
npm pack
dsh plugin --profile skills-test add "$PWD/dsh-skills-manager-0.1.0.tgz"

dsh --profile skills-test --no-open --port 3099
dsh plugin --profile skills-test remove dsh-skills-manager
```

`pnpm verify:profile` automates the tarball shape in an isolated `DSH_HOME`; `pnpm verify:profile -- --linked` does the same with a linked checkout (9 checks each).

From a Harness source checkout, select the built host entry with an overlay:

```yaml
# dev/overlay.example.yml — replace the path with your checkout
- insert:
    - id: skills-manager
      name: '/Users/you/code/dsh-skills-manager/lib/index.js'
      config:
        libraryDir: /Users/you/.dsh/skills-manager/library
```

```sh
cd deepseek-harness
pnpm dsh web --patch /path/to/dsh-skills-manager/dev/overlay.example.yml
```

## Use

Select **Skills** in the left sidebar (below **Plugins** and **Automation tasks**).

- **Add skill source** — a Git repository (`https://`, `ssh://`, `git@host:owner/repo`) or a local folder. A folder must contain `SKILL.md` at its root, under `skills/<name>/`, or under `skills/<category>/<name>/`. Git installs show live `git clone` output; local folders are copied without any nested `.git`.
- **Version** — `package.json` version when the source has one, else `git describe --tags --always --dirty` (tag, then short hash, with `-dirty` for local edits).
- **Check for updates** — fetches the Git remote and compares the local HEAD with its upstream: commits behind, commits ahead, a `-dirty` working tree, and the upstream version label. The last result is kept in `updates.json` and shown on the source card; checking is advisory and never touches the checkout.
- **Update** — `git pull --ff-only` for Git sources; a failed pull keeps its raw git output for diagnosis.
- **Remove** — deletes the source directory and its state entries.
- **Switches** — disable a whole source or a single skill. A disabled skill leaves the catalog entirely: the model cannot call it and `/name` no longer suggests it.
- **Link to project** — points a project's agent skills directories at the library with symlinks, so an update in the library reaches every project at once:
  - `dsh` targets `<project>/.dsh/skills`, the Harness `project-dsh` root, so a linked skill is visible to that project's sessions.
  - The other agent targets come from a pinned registry of project conventions (`.claude/skills`, `.codex/skills`, `.agents/skills`, …); pick any subset per project.
  - Occupied positions (a real directory, a file, or a foreign symlink) are reported as conflicts and never touched.
  - **Resync** rebuilds recorded links, repairs hand-repointed library links, and drops broken links and stale records.
  - **Per-project switch** — each recorded skill has its own switch in the project panel. Turning it off removes only that project's links and keeps the record, so the same skill can be on in one project and off in another.
  - **Two switch levels**: the library switch is the master (a globally disabled skill is unavailable everywhere); the per-project switch controls distribution into that project. Global disable detaches links but keeps project records, so re-enabling restores them automatically — except entries the user switched off in that project.
- **Search** filters by source, skill name, and description.
- Invalid or duplicated `SKILL.md` files stay visible with the reason, so a broken source is fixable instead of silently missing.

## Configuration

```yaml
- id: skills-manager
  name: dsh-skills-manager
  config:
    libraryDir: ~/.dsh/skills-manager/library          # default
    statePath: ~/.dsh/skills-manager/manager-state.json # default
    linksPath: ~/.dsh/skills-manager/links.json         # default
    updatesPath: ~/.dsh/skills-manager/updates.json     # default
    providerName: skills-manager
    rank: 450
    routePrefix: /dsh-skills-manager
    allowFileProtocol: true
```

| Field | Default | Meaning |
|---|---|---|
| `libraryDir` | `<dshHome>/skills-manager/library` | Managed library root |
| `statePath` | `<dshHome>/skills-manager/manager-state.json` | Enable flags, categories, notes |
| `linksPath` | `<dshHome>/skills-manager/links.json` | Per-project link intent |
| `updatesPath` | `<dshHome>/skills-manager/updates.json` | Last update check per source |
| `providerName` | `skills-manager` | Name registered on `ctx.skills` |
| `rank` | `450` | Provider precedence; lower wins (project skills at 100/200 still win) |
| `routePrefix` | `/dsh-skills-manager` | HTTP prefix for the Web Client API |
| `allowFileProtocol` | `true` | Accept `file://` Git identifiers (local repositories) |

The provider's rank sits between Harness user roots (400/500): a project skill with the same name overrides a library skill.

## HTTP API

All routes live under `routePrefix` and answer JSON with `cache-control: no-store`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/library` | Library snapshot: sources, skills, enable flags, problems |
| `POST` | `/api/sources/install` | `{ sourceType: 'git' \| 'local', identifier, force? }` → `202 { jobId }` |
| `GET` | `/api/jobs/:jobId` | `{ id, status, error, log }` |
| `POST` | `/api/sources/:slug/update` | Git update → `202 { jobId }` |
| `DELETE` | `/api/sources/:slug` | Remove source + state |
| `PUT` | `/api/sources/:slug` | `{ enabled?, category?, note? }` (disabling cascades links) |
| `PUT` | `/api/sources/:slug/skills/:skill` | `{ enabled?, note? }` (disabling cascades the link) |
| `GET` | `/api/agents` | Agent directory registry used by project links |
| `GET` | `/api/links` | Recorded projects with refreshed link state |
| `POST` | `/api/links` | `{ project, source, skillName?, agents? }` → link report |
| `PUT` | `/api/links` | `{ project, source, skillName?, enabled }` → per-project switch |
| `DELETE` | `/api/links` | Same body → unlink report (drops the record) |
| `POST` | `/api/links/resync` | `{ project }` → repair report |
| `POST` | `/api/sources/:slug/check` | Fetch + compare with upstream → `{ check }` |

Failures use `{ "error": { "code", "message" } }` with codes such as `SKILL_SOURCE_INVALID`, `SKILL_SLUG_CONFLICT`, `SKILL_FETCH_FAILED`, `SKILL_UPDATE_FAILED`, `SKILL_UPDATE_UNSUPPORTED`, `GIT_UNAVAILABLE`, `UNTRUSTED_REQUEST`.

## Security

- Mutating requests must be same-origin: `Host` must be loopback or a declared `trustedHosts` authority, `sec-fetch-site: cross-site` is refused, and a present `Origin` must match. These routes run `git clone`/`pull`, so they are not exposed to other pages.
- Git identifiers are restricted to `https://`, `ssh://`, `scp`-like `user@host:path`, and `file://` (configurable). `ext::` transports and option-shaped identifiers are rejected before any process starts.
- Every child process is spawned with an argument array — never through a shell — and `--` terminates Git option parsing.
- Source slugs and skill names must be single directory names; composed paths are checked to stay inside the library, and a local source may not equal, contain, or live inside the library.
- Project links only remove symlinks whose target resolves into the library (or the specific source being removed). Real directories, files, and symlinks pointing elsewhere are left in place and reported.

## Development

```sh
pnpm install
pnpm run typecheck     # host (tsc) + client (tsc, DOM + JSX) + tests
pnpm test              # vitest: library, state, installer (real git), links (real symlinks), HTTP, provider, registry
pnpm run build         # tsc → lib/, tsdown → client/client.js
pnpm run smoke:client  # load the built bundle and assert its registrations
```

The browser half is a `window.__ModuleLoader__.load(...)` factory produced by `tsdown`; `react` and `react/jsx-runtime` stay external and resolve through the host's module table. The Host half imports only Node built-ins, `yaml`, and `@deepseek-ai/dsh-home-paths`.

### Verify locally

```sh
pnpm verify:local     # source overlay path: builds, boots a real dsh web, runs 8 end-to-end checks
pnpm verify:profile   # bundle path: packs, installs into an isolated profile, boots it, runs 9 checks
```

It installs a local and a git source, links a project, exercises both switch levels, checks the update flow, and fetches the browser bundle — all in a temporary directory, never touching `~/.dsh` or your projects. `--keep` preserves the fixture and overlay for debugging; `DSH_HARNESS_DIR` points at another checkout.

The full matrix — unit level, manual UI checklist, model-level checks with the mock LLM, and installing as a profile bundle — lives in [docs/VERIFY.md](docs/VERIFY.md); integration into real profiles and Desktop is covered by [docs/INSTALL.md](docs/INSTALL.md).

Design notes and the phase plan live in [docs/DESIGN.md](docs/DESIGN.md).

## Versioning and update checks

The library owns the version story; no package manager or lockfile is involved:

| Question | Answer |
|---|---|
| What version is this source? | `package.json` `version`, else `git describe --tags --always --dirty` |
| Is an update available? | `POST /api/sources/:slug/check` runs `git fetch --tags --prune origin` and compares `HEAD` with `@{u}`; the result records `behind`, `ahead`, `dirty`, the upstream commit, and the upstream version label |
| How do I update? | **Update** runs `git pull --ff-only`; a fast-forward failure keeps the raw git output and never resets local work |
| Where is the result kept? | `updates.json`, keyed by source slug; the snapshot carries it as `SourceView.update` |
| What about local sources? | No upstream exists, so checking answers `SKILL_UPDATE_UNSUPPORTED`; reinstalling with **overwrite** is the update path |

This is deliberately the same model as the reference implementation (install into a central library, symlink out, `pull --ff-only` on demand). `vercel-labs/skills` is still not needed at runtime: it has no central library, no version management, and no update check — only the agent directory registry data, which is vendored.

## Credits

The agent directory snapshot in `src/agent-registry.ts` is derived from the registry in [`vercel-labs/skills`](https://github.com/vercel-labs/skills) v1.5.20 (`src/agents.ts`, MIT), plus one local `dsh` row. Only the data is used: fetching, linking, and repair stay in this plugin, so upstream releases cannot change runtime behavior. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Known limitations

- No filesystem watcher: edits made outside the UI become visible on the next invalidation (any manager operation) or after a restart.
- Categories and notes are supported by the state file and HTTP API, but the tab does not edit them yet.
- Global (user-level) distribution to other agents is not implemented; links are project-scoped. DSH itself sees the library globally through the provider.
- Re-enabling a disabled skill or source does not restore links automatically; run **Resync** on the project.
- `dsh web` is verified end-to-end on the Harness source checkout and on the published `0.2.1-rc.5` runtime; the Desktop shell (`dsh-app://`) still needs a manual pass.
- Harness plugin APIs are pre-stable: `engines.dsh` pins the range this version is tested against.
