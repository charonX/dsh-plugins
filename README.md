# dsh-skills-manager

A **skill library manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**. It installs skill sources from Git or a local folder, keeps them updated, lets you switch individual skills on or off, and exposes everything through a **Skills** tab on the Harness Plugins page.

Skills managed here are real Harness skills: they appear in the model's `skill` tool catalog and in the composer's `/` suggestions without any extra wiring.

```
$DSH_HOME/skills-manager/
├── library/                 # one directory per installed source
│   ├── owner-repo/SKILL.md                      # single-skill source
│   ├── other-repo/skills/<name>/SKILL.md        # multi-skill source
│   └── other-repo/skills/<category>/<name>/SKILL.md   # nested category layout
└── manager-state.json       # enable flags, categories, notes (sparse)
```

## Requirements

- Node.js ≥ 24.9
- DeepSeek Harness `0.2.2-alpha.x` (`engines.dsh` is `>=0.2.2-alpha.2 <0.3.0`)
- `git` on `PATH` only for Git sources; local-folder sources work without it

## Install

Into a Harness profile (a linked checkout while developing):

```sh
dsh plugin --profile web add /path/to/dsh-skills-manager
dsh --profile web --dump-config    # should show a "# == dsh-skills-manager" layer
dsh --profile web
```

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

Open **Plugins** in the sidebar and select the **Skills** tab.

- **Add skill source** — a Git repository (`https://`, `ssh://`, `git@host:owner/repo`) or a local folder. A folder must contain `SKILL.md` at its root, under `skills/<name>/`, or under `skills/<category>/<name>/`. Git installs show live `git clone` output; local folders are copied without any nested `.git`.
- **Update** — `git pull --ff-only` for Git sources; a failed pull keeps its raw git output for diagnosis.
- **Remove** — deletes the source directory and its state entries.
- **Switches** — disable a whole source or a single skill. A disabled skill leaves the catalog entirely: the model cannot call it and `/name` no longer suggests it.
- **Search** filters by source, skill name, and description.
- Invalid or duplicated `SKILL.md` files stay visible with the reason, so a broken source is fixable instead of silently missing.

## Configuration

```yaml
- id: skills-manager
  name: dsh-skills-manager
  config:
    libraryDir: ~/.dsh/skills-manager/library          # default
    statePath: ~/.dsh/skills-manager/manager-state.json # default
    providerName: skills-manager
    rank: 450
    routePrefix: /dsh-skills-manager
    allowFileProtocol: true
```

| Field | Default | Meaning |
|---|---|---|
| `libraryDir` | `<dshHome>/skills-manager/library` | Managed library root |
| `statePath` | `<dshHome>/skills-manager/manager-state.json` | Enable flags, categories, notes |
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
| `PUT` | `/api/sources/:slug` | `{ enabled?, category?, note? }` |
| `PUT` | `/api/sources/:slug/skills/:skill` | `{ enabled?, note? }` |

Failures use `{ "error": { "code", "message" } }` with codes such as `SKILL_SOURCE_INVALID`, `SKILL_SLUG_CONFLICT`, `SKILL_FETCH_FAILED`, `SKILL_UPDATE_FAILED`, `SKILL_UPDATE_UNSUPPORTED`, `GIT_UNAVAILABLE`, `UNTRUSTED_REQUEST`.

## Security

- Mutating requests must be same-origin: `Host` must be loopback or a declared `trustedHosts` authority, `sec-fetch-site: cross-site` is refused, and a present `Origin` must match. These routes run `git clone`/`pull`, so they are not exposed to other pages.
- Git identifiers are restricted to `https://`, `ssh://`, `scp`-like `user@host:path`, and `file://` (configurable). `ext::` transports and option-shaped identifiers are rejected before any process starts.
- Every child process is spawned with an argument array — never through a shell — and `--` terminates Git option parsing.
- Source slugs and skill names must be single directory names; composed paths are checked to stay inside the library, and a local source may not equal, contain, or live inside the library.

## Development

```sh
pnpm install
pnpm run typecheck     # host (tsc) + client (tsc, DOM + JSX)
pnpm test              # vitest: library scan, state, installer (real git), HTTP, provider
pnpm run build         # tsc → lib/, tsdown → client/client.js
```

The browser half is a `window.__ModuleLoader__.load(...)` factory produced by `tsdown`; `react` and `react/jsx-runtime` stay external and resolve through the host's module table. The Host half imports only Node built-ins, `yaml`, and `@deepseek-ai/dsh-home-paths`.

Design notes and the phase plan live in [docs/DESIGN.md](docs/DESIGN.md).

## Known limitations

- No filesystem watcher: edits made outside the UI become visible on the next invalidation (any manager operation) or after a restart.
- Categories and notes are supported by the state file and HTTP API, but the tab does not edit them yet.
- Project-level distribution (symlinking a library skill into `<project>/.dsh/skills`) is planned, not implemented.
- Verified against `dsh web` from the Harness source checkout; the Desktop shell and older Harness releases are not covered yet.
- Harness plugin APIs are pre-stable: `engines.dsh` pins the range this version is tested against.
