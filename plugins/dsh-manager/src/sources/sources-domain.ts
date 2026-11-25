import { z } from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable Source instance identity. */
export type SourceId = Branded<'SourceId'>

/** Source kinds the client can add; growable enum. */
export const SOURCE_KINDS = ['jira', 'gitlab-mr', 'gitlab-pipeline'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** Every kind a Source record can carry; `manual` instances back the user's own input. */
export const RECORD_SOURCE_KINDS = [...SOURCE_KINDS, 'manual'] as const
export type RecordSourceKind = (typeof RECORD_SOURCE_KINDS)[number]

/** The stable connection id the manual input rides; manual input needs no real connection. */
export const MANUAL_CONNECTION_ID = 'manual'
/** The deterministic id of the single manual Source instance. */
export const MANUAL_SOURCE_ID = 'manual-source'

/** The default watch: my open Jira issues, newest changes first. */
export const DEFAULT_JIRA_JQL = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'

/** The GitLab MR watch: my assigned MRs, MRs requesting my review, and new comments on my MRs. */
export const GITLAB_MR_KIND = 'gitlab-mr'

/** The smallest poll cadence the scheduler accepts. */
export const MIN_POLL_INTERVAL_MS = 10_000

/** The default poll cadence. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000

/** The accept modes a Source instance runs its evals under. */
export const ACCEPT_MODES = ['off', 'observe', 'auto'] as const
export type AcceptModeSetting = (typeof ACCEPT_MODES)[number]

/** One Source instance: one Source kind configured on one Connection. */
export const sourceRecord = z.object({
  id: z.string(),
  /** The connection this instance polls through. */
  connectionId: z.string(),
  /** Which Source kind this instance instantiates. */
  kind: z.enum(RECORD_SOURCE_KINDS),
  /** Whether the scheduler runs this instance. */
  enabled: z.boolean().default(true),
  /**
   * The accept mode of this instance's evals: `auto` mints tickets from
   * explicit evidence and offers candidates for inferred work, `observe`
   * offers everything as a candidate, `off` never offers.
   */
  acceptMode: z.enum(ACCEPT_MODES).default('auto'),
  /** The watch query; connector-specific syntax. Jira instances carry a JQL. */
  jql: z.string().min(1).optional(),
  /** The watched project paths; the GitLab pipeline watch carries them. */
  projects: z.array(z.string().min(1)).optional(),
  /** Poll cadence in millis; clamped to the minimum at write time. */
  pollIntervalMs: z.number().int().min(MIN_POLL_INTERVAL_MS),
  /** The newest external change fingerprint already collected. */
  cursor: z.string().optional(),
  /** Epoch millis of the last poll attempt, successful or not. */
  lastPollAt: z.number().optional(),
  /** The last poll failure, cleared by the next success. */
  lastError: z.string().optional(),
  /** Earliest epoch millis the instance may poll again after a 429. */
  rateLimitedUntil: z.number().optional(),
})

export type SourceRecord = z.infer<typeof sourceRecord>

/**
 * Durable Source instances. The cursor records polling progress for
 * efficiency; correctness comes from content-derived trigger ids, so a
 * restart or a repeated poll never duplicates collected changes.
 */
export const sourcesDomain = defineDomain({
  name: 'dsh_manager_sources',
  version: 1,
  tables: {
    sources: domainTable<SourceId, SourceRecord>(sourceRecord),
  },
})
