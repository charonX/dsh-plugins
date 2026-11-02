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
}

/** One link position observed on disk for a project. */
export interface LinkTargetView {
  /** Registry keys sharing this skills directory. */
  readonly agents: readonly string[]
  /** Project-relative skills directory. */
  readonly skillsDir: string
  /** Link name: the skill directory name. */
  readonly skillName: string
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
}

/** Default HTTP prefix owned by this plugin. */
export const DEFAULT_ROUTE_PREFIX = '/dsh-skills-manager'

/** Default locale namespace of the Web Client surface. */
export const LOCALE_NAMESPACE = 'skills-manager'
