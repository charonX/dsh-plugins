/**
 * Pure portfolio summary helpers for Steward Eval (dedup / subsumption) and
 * Route (cross-ticket conflict / sequencing via `dependsOn`).
 */
import type { TicketRecord, TicketState } from '../board-domain.ts'

const DEFAULT_RECENT_ENDED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_ACTIVE = 25
const DEFAULT_MAX_ENDED = 15

/** Compact summary of an in-flight or recently ended ticket visible to Steward. */
export interface PortfolioTicketEntry {
  readonly id: string
  readonly title: string
  readonly state: TicketState
  readonly projectId?: string
  readonly scope: string
  readonly acceptanceCriteria?: string
  readonly scratchDir?: string
  readonly dependsOn?: readonly string[]
  readonly supersededBy?: string
  readonly updatedAt: number
}

/** Partitioned view of active vs. recently ended tickets relevant to a project. */
export interface PortfolioSnapshot {
  readonly projectId?: string
  readonly active: readonly PortfolioTicketEntry[]
  readonly recentEnded: readonly PortfolioTicketEntry[]
}

export interface PortfolioSnapshotOptions {
  /** Project id to scope to; when set, excludes tickets belonging to other projects. */
  readonly projectId?: string
  /** Ticket ids (e.g., current ticket and its flow siblings) to omit from conflict list. */
  readonly excludeTicketIds?: readonly string[]
  /** Epoch millis used to filter recent ended tickets. */
  readonly now?: number
  /** How far back to keep `ended` tickets for bug-subsumption / dedup checks. */
  readonly recentEndedWindowMs?: number
  readonly maxActive?: number
  readonly maxEnded?: number
}

function toEntry(record: TicketRecord): PortfolioTicketEntry {
  return {
    id: record.id,
    title: record.title,
    state: record.state,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    scope: record.mandate?.scope ?? '',
    ...(record.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: record.acceptanceCriteria }),
    ...(record.scratchDir === undefined ? {} : { scratchDir: record.scratchDir }),
    ...(record.dependsOn === undefined ? {} : { dependsOn: record.dependsOn }),
    ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
    updatedAt: record.updatedAt,
  }
}

/**
 * Build a bounded `PortfolioSnapshot` from durable tickets:
 * - Includes active (`todo`, `running`, `attention`) tickets newest-first.
 * - Includes `ended` tickets updated within `recentEndedWindowMs` newest-first.
 * - When `projectId` is given, only keeps matching `projectId` tickets.
 */
export function buildPortfolioSnapshot(
  tickets: readonly TicketRecord[],
  options: PortfolioSnapshotOptions = {},
): PortfolioSnapshot {
  const excluded = new Set(options.excludeTicketIds ?? [])
  const now = options.now ?? Date.now()
  const cutoff = now - (options.recentEndedWindowMs ?? DEFAULT_RECENT_ENDED_WINDOW_MS)
  const maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE
  const maxEnded = options.maxEnded ?? DEFAULT_MAX_ENDED

  const relevant = tickets.filter(ticket => {
    if (excluded.has(ticket.id)) return false
    if (options.projectId !== undefined && ticket.projectId !== options.projectId) return false
    return true
  })

  const active = relevant
    .filter(ticket => ticket.state !== 'ended')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxActive)
    .map(toEntry)

  const recentEnded = relevant
    .filter(ticket => ticket.state === 'ended' && ticket.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxEnded)
    .map(toEntry)

  return {
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    active,
    recentEnded,
  }
}

function formatEntryLine(entry: PortfolioTicketEntry): string {
  const parts = [
    `[${entry.id}]`,
    `state=${entry.state}`,
    ...(entry.projectId === undefined ? [] : [`project=${entry.projectId}`]),
    `title=${JSON.stringify(entry.title)}`,
    ...(entry.scope === '' ? [] : [`scope=${JSON.stringify(entry.scope)}`]),
    ...(entry.dependsOn === undefined || entry.dependsOn.length === 0 ? [] : [`dependsOn=[${entry.dependsOn.join(', ')}]`]),
    ...(entry.supersededBy === undefined ? [] : [`supersededBy=${entry.supersededBy}`]),
    ...(entry.scratchDir === undefined ? [] : [`scratchDir=${entry.scratchDir}`]),
  ]
  return `- ${parts.join(' | ')}`
}

/** Format a `PortfolioSnapshot` into compact Markdown lines for Steward prompts. */
export function formatPortfolioPromptLines(snapshot: PortfolioSnapshot): string[] {
  const lines: string[] = []
  const headerSuffix = snapshot.projectId === undefined ? 'all projects' : `project ${snapshot.projectId}`
  if (snapshot.active.length === 0 && snapshot.recentEnded.length === 0) {
    lines.push(`Portfolio tickets (${headerSuffix}): none`)
    return lines
  }
  lines.push(`Portfolio tickets (${headerSuffix}):`)
  if (snapshot.active.length > 0) {
    lines.push('Active (`todo` / `running` / `attention`):')
    for (const entry of snapshot.active) lines.push(formatEntryLine(entry))
  }
  if (snapshot.recentEnded.length > 0) {
    lines.push('Recently ended (may already fix/cover incoming bug reports):')
    for (const entry of snapshot.recentEnded) lines.push(formatEntryLine(entry))
  }
  return lines
}
