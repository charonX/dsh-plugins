/**
 * The Watchdog: periodic sweeps for silent dispatches, consecutive failure
 * runs, and dead connections (spec story 81). Every finding becomes a
 * question attention on the board's 待人工 column — a problem is never
 * silently swallowed. The sweep timer lives in a plugin effect and is
 * released when DSH stops.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { askAttention, settleMatchingPendingAttentions, type AttentionRecord } from './attention/attention-core.ts'
import { hasPendingFinding, watchdogFindings, type WatchdogFinding } from './watchdog/watchdog-core.ts'

/** Watchdog facet configuration; every knob is optional with a sane default. */
export interface WatchdogConfig {
  /** The sweep cadence in milliseconds; defaults to 60s. */
  intervalMs?: number
  /** How long a live dispatch may stay silent before it counts as stalled; defaults to 10 minutes. */
  progressTimeoutMs?: number
  /** How many consecutive failed dispatches raise a finding; defaults to 3. */
  failureThreshold?: number
}

export const WatchdogConfig: z<WatchdogConfig> = z.object({
  intervalMs: z.natural(),
  progressTimeoutMs: z.natural(),
  failureThreshold: z.natural(),
})

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_PROGRESS_TIMEOUT_MS = 600_000
const DEFAULT_FAILURE_THRESHOLD = 3

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Watchdog sweeping dispatches and connections for anomalies. */
    dshManagerWatchdog: DshManagerWatchdog
  }
}

export class DshManagerWatchdog extends Service {
  /** The board's stores and the connections' connectivity test. */
  static inject = ['dshManagerBoard', 'dshManagerConnections']

  static Config: z<WatchdogConfig> = WatchdogConfig

  private config: WatchdogConfig
  /** Whether one sweep is in flight; sweeps never overlap. */
  private sweeping = false

  constructor(ctx: Context, config: WatchdogConfig) {
    super(ctx, 'dshManagerWatchdog')
    this.config = config
  }

  protected [Service.init](): void {
    // The sweep timer is a plugin effect: released with the bundle on stop.
    const intervalMs = this.config.intervalMs ?? DEFAULT_INTERVAL_MS
    this.ctx.effect(() => {
      const timer = setInterval(() => { void this.runOnce().catch(() => {}) }, intervalMs)
      return () => { clearInterval(timer) }
    }, 'dsh-manager: watchdog sweep interval')
  }

  /**
   * Run one sweep now: dispatch stalls, failure runs, and connection health
   * (the connections' own connectivity test). Findings already pending on
   * the board are skipped — the same problem never mints twice in a row.
   * @returns the attentions this sweep minted.
   */
  async runOnce(): Promise<readonly AttentionRecord[]> {
    // Sweeps never overlap: an overlapping pass would read the pending set
    // before the previous pass minted, and the same problem would mint twice.
    if (this.sweeping) return []
    this.sweeping = true
    try {
      return await this.runOnceInner()
    } finally {
      this.sweeping = false
    }
  }

  /** The sweep body, serialized by {@link runOnce}. */
  private async runOnceInner(): Promise<readonly AttentionRecord[]> {
    const store = this.ctx.dshManagerBoard.attentionStore()
    const dispatchStore = this.ctx.dshManagerBoard.dispatchStore()
    const now = Date.now()
    await settleMatchingPendingAttentions(
      store,
      record => {
        if (!record.details?.startsWith('watchdog:stall:')) return false
        const dispatch = dispatchStore.getDispatch(record.details.slice('watchdog:stall:'.length))
        return dispatch === undefined || dispatch.state === 'ended'
      },
      'dispatch ended',
      now,
    )
    await settleMatchingPendingAttentions(
      store,
      record => {
        if (!record.details?.startsWith('watchdog:stall:')) return false
        const dispatch = dispatchStore.getDispatch(record.details.slice('watchdog:stall:'.length))
        return dispatch !== undefined && dispatch.state !== 'ended' && dispatch.updatedAt > record.createdAt
      },
      'activity resumed',
      now,
    )
    const pending = store.listAttentions()
    const progressTimeoutMs = this.config.progressTimeoutMs ?? DEFAULT_PROGRESS_TIMEOUT_MS
    const failureThreshold = this.config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    const dispatchFindings = watchdogFindings({
      dispatches: dispatchStore.listDispatches(),
      now,
      progressTimeoutMs,
      failureThreshold,
    })
    const connectionFindings = await this.connectionFindings()
    const minted: AttentionRecord[] = []
    for (const finding of [...dispatchFindings, ...connectionFindings]) {
      if (hasPendingFinding(pending, finding)) continue
      minted.push(await askAttention(store, {
        ticketId: finding.ticketId,
        dispatchId: 'watchdog',
        kind: 'question',
        question: finding.question,
        details: finding.details,
      }, now))
    }
    return minted
  }

  /**
   * Probe every enabled connection through its own connectivity test and
   * turn failures into findings keyed by the connection id.
   */
  private async connectionFindings(): Promise<readonly WatchdogFinding[]> {
    const { connections } = await this.ctx.dshManagerConnections.connectionList()
    const findings: WatchdogFinding[] = []
    for (const connection of connections) {
      if (!connection.enabled) continue
      const result = await this.ctx.dshManagerConnections.connectionTest(connection.id)
      if (result.ok) continue
      findings.push({
        key: `watchdog:connection:${connection.id}`,
        ticketId: '',
        question: `Connection ${connection.name} (${connection.connector}) is unhealthy: ${result.reason}.`,
        details: `watchdog:connection:${connection.id}`,
      })
    }
    return findings
  }
}

export default DshManagerWatchdog
