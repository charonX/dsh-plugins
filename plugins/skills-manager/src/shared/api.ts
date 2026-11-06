/**
 * Wire types shared by the Host HTTP routes and the Web Client bundle.
 *
 * Type-only imports are erased at build time, so the browser bundle carries no
 * Host code from this module.
 *
 * @module dsh-skills-manager/shared
 */

/** Invocation controls mirrored from `@deepseek-ai/dsh-skill`. */
export interface SkillInvocationPolicy {
  /** Whether the model-facing catalog and `skill` tool include this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing `/` suggestions include this skill. */
  readonly userInvocable: boolean
}

/** Result of one git update check. */
export interface UpdateCheck {
  /** ISO timestamp of this observation. */
  readonly checkedAt: string
  /** Local HEAD commit. */
  readonly localCommit?: string
  /** Upstream commit, when the source has one. */
  readonly remoteCommit?: string
  /** Commits the local checkout is behind. */
  readonly behind?: number
  /** Commits the local checkout is ahead of upstream. */
  readonly ahead?: number
  /** Whether the working tree has uncommitted changes. */
  readonly dirty?: boolean
  /** Version-ish label of the upstream commit. */
  readonly remoteVersion?: string
  /** Failure recorded instead of a comparison. */
  readonly error?: { readonly code: string; readonly message: string }
}

/** One skill discovered inside a managed source. */
export interface SkillView {
  /** Directory name; stable identity inside its source. */
  readonly skillName: string
  /** Catalog name from frontmatter; absent when the file is invalid. */
  readonly name?: string
  /** Routing description from frontmatter. */
  readonly description?: string
  /** Optional extra routing guidance from frontmatter. */
  readonly whenToUse?: string
  /** Resolved invocation controls. */
  readonly invocation: SkillInvocationPolicy
  /** Path relative to the source directory, for display. */
  readonly relativePath: string
  /** Whether the file passed name/description/invocation validation. */
  readonly valid: boolean
  /** Why the file is invalid; present only when `valid` is false. */
  readonly problem?: string
  /** Whether the skill is enabled in the manager state. */
  readonly enabled: boolean
  /** Free-form note from the manager state. */
  readonly note?: string
}

/** One managed source (a git clone or a local copy) inside the skill library. */
export interface SourceView {
  /** Directory name inside the library. */
  readonly slug: string
  /** How the source was installed. */
  readonly sourceType: 'git' | 'local'
  /** `origin` remote of a git source. */
  readonly sourceUrl?: string
  /** `package.json` version, else the git short hash. */
  readonly version?: string
  /** Whether every skill of this source is enabled by default. */
  readonly enabled: boolean
  /** Grouping label from the manager state. */
  readonly category?: string
  /** Free-form note from the manager state. */
  readonly note?: string
  /** Source-level problem, such as an empty or unreadable directory. */
  readonly problem?: string
  /** Last recorded update check for a git source. */
  readonly update?: UpdateCheck
  /** Discovered skills, sorted by directory name. */
  readonly skills: readonly SkillView[]
}

/** Full library observation returned by `GET /api/library`. */
export interface LibrarySnapshot {
  /** Absolute library root. */
  readonly libraryDir: string
  /** Absolute state file path. */
  readonly statePath: string
  /** Sources sorted by slug. */
  readonly sources: readonly SourceView[]
}

/** Lifecycle of one asynchronous install or update. */
export type JobStatus = 'pending' | 'running' | 'success' | 'error'

/** Terminal error of a failed job. */
export interface JobError {
  /** Machine-readable code, for example `SKILL_FETCH_FAILED`. */
  readonly code: string
  /** Human-readable message, carrying the raw git error when there is one. */
  readonly message: string
}

/** Polling view of one job. */
export interface JobView {
  /** Job id returned by the accepted request. */
  readonly id: string
  /** Current lifecycle state. */
  readonly status: JobStatus
  /** Terminal error; null unless status is `error`. */
  readonly error: JobError | null
  /** Accumulated command output; null until the command emits something. */
  readonly log: string | null
}

/** Error envelope shared by every route. */
export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string }
}

/** Accepted-job envelope. */
export interface JobAcceptedBody {
  readonly jobId: string
}

/** Body of `POST /api/sources/install`. */
export interface InstallRequestBody {
  /** Transport used to bring the source into the library. */
  readonly sourceType: 'git' | 'local'
  /** Git identifier or absolute/`~` local directory. */
  readonly identifier: string
  /** Replace an existing local source with the same slug. */
  readonly force?: boolean
}

/** Body of `PUT /api/sources/:slug`. */
export interface SourcePatch {
  readonly enabled?: boolean
  readonly category?: string
  readonly note?: string
}

/** Body of `PUT /api/sources/:slug/skills/:skill`. */
export interface SkillPatch {
  readonly enabled?: boolean
  readonly note?: string
}

/** One global skill root offered by the import scanner. */
export interface ScanRootView {
  /** Stable key, also used for the imported source slug. */
  readonly key: string
  /** Human-readable origin, e.g. the agent name. */
  readonly label: string
  /** Absolute root path. */
  readonly path: string
  /** Whether the root exists on this machine. */
  readonly exists: boolean
}

/** Library entry that shares a scanned skill's catalog name. */
export interface ScanExistingView {
  /** Source slug in the library. */
  readonly source: string
  /** Skill directory name in that source. */
  readonly skillName: string
  /** Content hash of the library copy. */
  readonly hash: string
}

/** One skill discovered outside the library. */
export interface ScanSkillView {
  /** Absolute path of SKILL.md (or the flat `<name>.md`). */
  readonly path: string
  /** Catalog name from frontmatter, or the file/directory name when invalid. */
  readonly name: string
  /** On-disk directory (or flat file stem). */
  readonly dirName: string
  /** Routing description. */
  readonly description?: string
  /** sha256 of the SKILL.md contents. */
  readonly hash: string
  /** Why the file cannot be imported. */
  readonly problem?: string
  /** Registry key of the origin root. */
  readonly originKey: string
  /** Display label of the origin root. */
  readonly originLabel: string
  /** Absolute origin root path. */
  readonly originPath: string
  /** Import decision relative to the current library. */
  readonly status: 'importable' | 'imported' | 'conflict' | 'invalid'
  /** Existing library copy when the name is already managed. */
  readonly existing?: ScanExistingView
}

/** Response of `GET /api/scan`. */
export interface ScanResponse {
  /** Roots the scanner looked at, including missing ones. */
  readonly roots: readonly ScanRootView[]
  /** Discovered skills, grouped by origin then name. */
  readonly skills: readonly ScanSkillView[]
}

/** Body of `POST /api/import`. */
export interface ImportRequest {
  /** Absolute SKILL.md/`<name>.md` paths returned by the scan. */
  readonly paths: readonly string[]
  /** Replace a conflicting copy that this manager imported earlier. */
  readonly overwrite?: boolean
}

/** One import result. */
export interface ImportOutcome {
  /** Requested path. */
  readonly path: string
  /** Catalog name. */
  readonly name: string
  /** What happened. */
  readonly status: 'imported' | 'overwritten' | 'skipped' | 'conflict' | 'failed'
  /** Imported source slug, when a copy was written. */
  readonly source?: string
  /** Skill directory name inside that source. */
  readonly skillName?: string
  /** Machine-readable failure/conflict code. */
  readonly code?: string
  /** Human-readable explanation. */
  readonly message?: string
}

/** Response of `POST /api/import`. */
export interface ImportResponse {
  /** One row per requested path. */
  readonly outcomes: readonly ImportOutcome[]
}

/** One DSH workspace offered as a link target. */
export interface WorkspaceOptionView {
  /** Absolute workspace directory. */
  readonly path: string
  /** Workspace title. */
  readonly title: string
}

/** One agent-directory convention from the pinned registry snapshot. */
export interface AgentTargetView {
  /** Stable registry key used in link requests and records. */
  readonly name: string
  /** Human-readable agent name. */
  readonly displayName: string
  /** Project-relative skills directory. */
  readonly skillsDir: string
  /** Whether many agents share this directory convention. */
  readonly universal: boolean
}

/** A recorded source/skill association of one project. */
export interface LinkEntryView {
  /** Source slug. */
  readonly source: string
  /** Skill directory name. */
  readonly skillName: string
  /** Whether this project distributes the skill; false keeps the record but removes its links. */
  readonly enabled: boolean
}

/** One link position observed on disk for a project. */
export interface LinkTargetView {
  /** Registry keys sharing this skills directory. */
  readonly agents: readonly string[]
  /** Project-relative skills directory. */
  readonly skillsDir: string
  /** Link name: the skill directory name. */
  readonly skillName: string
  /** Recorded source slug, present for recorded positions. */
  readonly source?: string
  /** Observed state of the link position. */
  readonly state: 'linked' | 'missing' | 'broken' | 'conflict' | 'external'
  /** Absolute link path. */
  readonly path: string
  /** Resolved target for a healthy link, or the intended target for a missing one. */
  readonly target?: string
  /** Why the position is not usable, for `broken`, `conflict`, and `external`. */
  readonly problem?: string
}

/** One project's link state. */
export interface ProjectLinkView {
  /** Absolute project directory. */
  readonly project: string
  /** Whether the project directory still exists. */
  readonly exists: boolean
  /** Agent keys recorded for this project. */
  readonly agents: readonly string[]
  /** Recorded associations. */
  readonly entries: readonly LinkEntryView[]
  /** Observed link positions, one per unique skills directory and skill. */
  readonly targets: readonly LinkTargetView[]
  /** Entries recorded for the project whose skill is no longer in the library. */
  readonly stale: readonly LinkEntryView[]
}

/** Result of a link, unlink, or resync request. */
export interface LinkReport {
  /** Project state after the operation. */
  readonly project: ProjectLinkView
  /** Counts per observed state after the operation. */
  readonly counts: Readonly<Record<'linked' | 'missing' | 'broken' | 'conflict' | 'external', number>>
}

/** Body of `POST /api/links` and `DELETE /api/links`. */
export interface LinkRequestBody {
  /** Absolute project directory. */
  readonly project: string
  /** Source slug. */
  readonly source: string
  /** One skill of the source; omitted links every enabled skill of the source. */
  readonly skillName?: string
  /** Agent keys to target; omitted uses the project's recorded agents or `dsh`. */
  readonly agents?: readonly string[]
  /** Per-project distribution switch; required by `PUT /api/links`. */
  readonly enabled?: boolean
}

/** Default HTTP prefix owned by this plugin. */
export const DEFAULT_ROUTE_PREFIX = '/dsh-skills-manager'

/** Default locale namespace of the Web Client surface. */
export const LOCALE_NAMESPACE = 'skills-manager'
