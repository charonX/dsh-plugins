/**
 * The Watchdog's decision core: which dispatches stalled, how many
 * consecutive failures a ticket carries, and which findings are already on
 * the board. Pure over plain records — persistence stays in the adapters
 * (ADR-0003).
 */
import type { DispatchRecord } from '../dispatch/dispatch-core.ts'
import type { AttentionRecord } from '../attention/attention-core.ts'

/** One anomaly the Watchdog wants a human to see. */
export interface WatchdogFinding {
  /** Stable anomaly key; the dedupe marker carried in the attention details. */
  key: string
  /** The ticket the finding is about; `''` when it is bundle-wide. */
  ticketId: string
  /** The ask shown on the board. */
  question: string
  /** Diagnostic detail; doubles as the dedupe marker. */
  details: string
}

/**
 * Live (queued or running) dispatches whose last progress lies further back
 * than `progressTimeoutMs`. An ended dispatch never stalls.
 */
export function stalledDispatches(dispatches: readonly DispatchRecord[], now: number, progressTimeoutMs: number): readonly DispatchRecord[] {
  return dispatches.filter(dispatch =>
    dispatch.state !== 'ended' && now - dispatch.updatedAt > progressTimeoutMs)
}

/**
 * The ticket's consecutive failed dispatches: the run of most recent ended
 * dispatches that all failed, broken by any clean outcome or by a live
 * (queued/running) dispatch — work in progress resets the run.
 */
export function consecutiveFailures(dispatches: readonly DispatchRecord[], ticketId: string): number {
  const own = dispatches
    .filter(dispatch => dispatch.ticketId === ticketId)
    .sort((left, right) => right.createdAt - left.createdAt)
  let count = 0
  for (const dispatch of own) {
    if (dispatch.state !== 'ended') break
    if (dispatch.outcome !== 'failed') break
    count += 1
  }
  return count
}

/**
 * Every dispatch-side finding for one sweep: a stall finding per silent live
 * dispatch, and one failure-run finding per ticket past the threshold.
 */
export function watchdogFindings(input: {
  readonly dispatches: readonly DispatchRecord[]
  readonly now: number
  readonly progressTimeoutMs: number
  readonly failureThreshold: number
}): readonly WatchdogFinding[] {
  const findings: WatchdogFinding[] = []
  for (const dispatch of stalledDispatches(input.dispatches, input.now, input.progressTimeoutMs)) {
    findings.push({
      key: `watchdog:stall:${dispatch.id}`,
      ticketId: dispatch.ticketId,
      question: `Dispatch ${dispatch.id} on ticket ${dispatch.ticketId} has made no progress for ${input.now - dispatch.updatedAt} ms.`,
      details: `watchdog:stall:${dispatch.id}`,
    })
  }
  const ticketIds = new Set(input.dispatches.map(dispatch => dispatch.ticketId))
  for (const ticketId of ticketIds) {
    const failures = consecutiveFailures(input.dispatches, ticketId)
    if (failures < input.failureThreshold) continue
    findings.push({
      key: `watchdog:failures:${ticketId}`,
      ticketId,
      question: `Ticket ${ticketId} has ${failures} consecutive failed dispatches.`,
      details: `watchdog:failures:${ticketId}`,
    })
  }
  return findings
}

/**
 * Whether one finding is already on the board: a pending attention carrying
 * the finding key in its details. Answered attentions do not dedupe — the
 * same problem may ask again.
 */
export function hasPendingFinding(attentions: readonly AttentionRecord[], finding: Pick<WatchdogFinding, 'key'>): boolean {
  return attentions.some(attention =>
    attention.status === 'pending' && attention.details === finding.key)
}
