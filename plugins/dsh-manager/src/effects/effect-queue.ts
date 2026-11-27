/**
 * The effect queue domain core: durable at-least-once delivery with
 * target-side idempotency keys. Pure state machine over the
 * {@link EffectStorePort} — persistence is a thin adapter, so tests drive
 * this core in memory (ADR-0003).
 */

import type { EffectRecord } from './effects-domain.ts'

export type { EffectRecord }

/** Durable record storage the queue drives; synchronous reads, durable writes. */
export interface EffectStorePort {
  /** Every stored record. */
  list(): readonly EffectRecord[]
  /** Persist one record; resolves only after durability. */
  put(record: EffectRecord): Promise<void>
  /** Subscribe to durable changes (any record); returns a disposer. */
  subscribe(listener: () => void): () => void
}

/** One effect handed to its deliverer. */
export interface EffectDelivery {
  readonly id: string
  readonly kind: string
  readonly payload: unknown
}

/** A deliverer performs the outward action. Rejection retries with backoff. */
export type EffectDeliverer = (delivery: EffectDelivery) => Promise<void>

/** A registered kind had no deliverer: transient composition state, not a delivery failure. */
export class MissingDelivererError extends Error {
  override name = 'MissingDelivererError'
  constructor(readonly kind: string) {
    super(`no deliverer for kind: ${kind}`)
  }
}

/** Queue construction options; every dependency is injected for tests. */
export interface EffectQueueOptions {
  /** Durable record storage. */
  readonly store: EffectStorePort
  /** Dispatches one effect by kind; missing kinds answer MissingDelivererError. */
  readonly deliver: EffectDeliverer
  /** Epoch-millis clock. */
  readonly now?: () => number
  /** Retry backoff by attempt number (1-based); default 1s × 4^(n−1). */
  readonly backoffMs?: (attempt: number) => number
  /** Deliverer invocations before the record settles to failed; default 5. */
  readonly maxAttempts?: number
  /** Reschedule delay while a kind's deliverer is unregistered; default 250ms. */
  readonly missingDelivererRetryMs?: number
}

/** The queue face the host service holds. */
export interface EffectQueue {
  /** Persist a new pending effect and return its idempotency key. */
  enqueue(envelope: { kind: string; payload: unknown }): Promise<string>
  /** Boot-time sweep: re-deliver crashed in-flight records, schedule due pending ones. */
  recover(): Promise<void>
  /** Every stored record, in store order — for queryable diagnosis. */
  records(): readonly EffectRecord[]
  /** Stop the scheduler; durable state stays queryable. */
  stop(): Promise<void>
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_MISSING_RETRY_MS = 250

function defaultBackoff(attempt: number): number {
  return 1_000 * 4 ** (attempt - 1)
}

/**
 * Create the effect queue over a store port. Delivery marks the record
 * in-flight (durable) before invoking the deliverer, so a crash anywhere
 * leaves a record the next boot's recover() converges; targets dedup on the
 * idempotency key (ADR-0003).
 * @param options - store, deliverer dispatch, and tuning knobs.
 * @returns the queue face.
 */
export function createEffectQueue(options: EffectQueueOptions): EffectQueue {
  const now = options.now ?? (() => Date.now())
  const backoffMs = options.backoffMs ?? defaultBackoff
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const missingRetryMs = options.missingDelivererRetryMs ?? DEFAULT_MISSING_RETRY_MS
  const { store, deliver } = options

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const unsubscribe = store.subscribe(() => { schedule() })

  const pending = (): EffectRecord[] =>
    store.list().filter(record => record.status === 'pending')
  const due = (record: EffectRecord): boolean => record.nextAttemptAt <= now()

  /** Persist a record transition with a fresh updatedAt; skips once stopped. */
  async function transition(record: EffectRecord, patch: Partial<EffectRecord>): Promise<void> {
    if (stopped) return
    try {
      await store.put({ ...record, ...patch, updatedAt: now() })
    } catch (error) {
      if (stopped && typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'closed') {
        return
      }
      throw error
    }
  }

  /** Schedule the timer for the earliest pending record; a no-op when stopped. */
  function schedule(): void {
    if (stopped) return
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const next = pending().sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0]
    if (next === undefined) return
    const delay = Math.max(0, next.nextAttemptAt - now())
    timer = setTimeout(() => {
      void run(next.id).catch((error: unknown) => {
        if (stopped && typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'closed') {
          return
        }
        throw error
      })
    }, delay)
  }

  /** Claim, deliver, and settle one record by id; failures follow the retry ladder. */
  async function run(id: string, allowInFlight = false): Promise<void> {
    const record = store.list().find(candidate => candidate.id === id)
    if (record === undefined || stopped) return
    if (record.status === 'in-flight' && !allowInFlight) return
    if (record.status !== 'pending' && record.status !== 'in-flight') return
    if (record.status === 'pending' && !due(record)) {
      // Node/libuv timers can fire ~1ms before wall-clock `now()` reaches `nextAttemptAt`;
      // re-arm instead of dropping the record into an unscheduled state.
      schedule()
      return
    }
    const attemptsBefore = record.attempts
    await transition(record, { status: 'in-flight', attempts: attemptsBefore + 1 })
    try {
      await deliver({ id: record.id, kind: record.kind, payload: record.payload })
    } catch (error) {
      if (error instanceof MissingDelivererError) {
        // Composition state, not a delivery failure: keep the attempt count
        // and reschedule shortly.
        await transition(record, {
          status: 'pending',
          attempts: attemptsBefore,
          nextAttemptAt: now() + missingRetryMs,
          lastError: error.message,
        })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      if (attemptsBefore + 1 >= maxAttempts) {
        await transition(record, { status: 'failed', attempts: attemptsBefore + 1, lastError: message })
        return
      }
      await transition(record, {
        status: 'pending',
        attempts: attemptsBefore + 1,
        nextAttemptAt: now() + backoffMs(attemptsBefore + 1),
        lastError: message,
      })
      return
    }
    await transition(record, { status: 'done' })
  }

  return {
    async enqueue(envelope) {
      const id = crypto.randomUUID()
      const moment = now()
      await store.put({
        id,
        kind: envelope.kind,
        payload: envelope.payload,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: moment,
        updatedAt: moment,
      })
      schedule()
      return id
    },
    async recover() {
      for (const record of store.list()) {
        if (record.status === 'in-flight') {
          // The process crashed between the durable claim and the settle
          // write: re-deliver (targets dedup on the idempotency key).
          await run(record.id, true)
          continue
        }
        if (record.status === 'pending' && due(record)) {
          await run(record.id)
        }
      }
      schedule()
    },
    records() {
      return store.list()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      unsubscribe()
    },
  }
}
