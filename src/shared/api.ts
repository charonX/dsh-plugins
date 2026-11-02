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

/** Default HTTP prefix owned by this plugin. */
export const DEFAULT_ROUTE_PREFIX = '/dsh-skills-manager'

/** Default locale namespace of the Web Client surface. */
export const LOCALE_NAMESPACE = 'skills-manager'
