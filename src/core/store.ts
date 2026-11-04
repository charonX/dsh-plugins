/**
 * Event-sourcing journal store for the Autoloop microkernel.
 * Persists an append-only log of JSONL events and reconstructs memory state by
 * replaying it on boot.
 *
 * The log is compacted: once it grows past a line threshold, or when retained
 * history has expired, the store rewrites it as one `snapshot` entry holding
 * every ticket worth keeping and atomically replaces the file. Active tickets
 * are never dropped; finished tickets are dropped once they are older than the
 * configured retention.
 *
 * Durability contract: `append` persists before it applies, so memory never
 * runs ahead of the log. A failed write leaves both untouched and throws.
 *
 * @module @charonx/dsh-autoloop/core/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { JournalEntry, JournalLogger, ScheduleMode, Ticket, TicketStatus } from '../shared/types.js'

/** Finished statuses whose history retention applies. */
const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set(['completed', 'failed', 'circuit_broken'])

/** Compaction result. */
export interface CompactionResult {
  /** Lines written to the replacement journal. */
  readonly lines: number
  /** Tickets kept. */
  readonly kept: number
  /** Finished tickets dropped by retention. */
  readonly dropped: number
}

export interface JournalStoreOptions {
  /** Days a finished ticket stays in the journal; defaults to 14. */
  completedRetentionDays?: number
  /** Line count that triggers compaction; defaults to 2000. */
  compactAfterLines?: number
  /** Warning sink for corrupt lines and compaction failures. */
  logger?: JournalLogger
}

/**
 * Read one stored schedule mode, folding the retired `nightly` spelling into
 * `offpeak`. Journals written before the window became configurable keep
 * replaying; the alias never leaves this decoder.
 * @param mode - Mode read from the journal.
 * @returns The current spelling.
 */
function migrateScheduleMode(mode: ScheduleMode | 'nightly' | undefined): ScheduleMode {
  if (mode === 'nightly') return 'offpeak'
  return mode ?? 'immediate'
}

/**
 * Fill the defaults a row may predate.
 * @param ticket - Ticket read from the journal.
 * @returns The same object, normalized in place.
 */
function normalizeTicket(ticket: Ticket): Ticket {
  if (!ticket.priority) ticket.priority = 'p2'
  ticket.scheduleMode = migrateScheduleMode(ticket.scheduleMode)
  return ticket
}

export class JournalStore {
  private readonly tickets = new Map<string, Ticket>()
  private lines = 0
  private corrupt = 0
  private readonly retentionMs: number
  private readonly compactAfterLines: number
  private readonly logger?: JournalLogger

  constructor(public readonly filePath: string, options: JournalStoreOptions = {}) {
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    this.retentionMs = Math.max(1, options.completedRetentionDays ?? 14) * 86_400_000
    this.compactAfterLines = Math.max(100, options.compactAfterLines ?? 2000)
    this.logger = options.logger
    this.replay()
    // Bounded on boot: drop expired history and collapse the log before serving.
    this.compactIfNeeded('boot')
  }

  /** Journal lines currently on disk. */
  get lineCount(): number {
    return this.lines
  }

  /** Lines skipped during replay because they could not be decoded. */
  get corruptLineCount(): number {
    return this.corrupt
  }

  /** Read-only collection of all loaded tickets */
  getAllTickets(): Ticket[] {
    return Array.from(this.tickets.values())
  }

  /** Find ticket by id */
  getTicket(id: string): Ticket | undefined {
    return this.tickets.get(id)
  }

  /** Find the active ticket currently running on a specific thread */
  findActiveTicketOnThread(threadId: string): Ticket | undefined {
    for (const ticket of this.tickets.values()) {
      if (
        ticket.threadId === threadId &&
        (ticket.status === 'pending' || ticket.status === 'running' || ticket.status === 'waiting_attention')
      ) {
        return ticket
      }
    }
    return undefined
  }

  /**
   * Append entry to the journal and apply it to memory.
   *
   * The write happens first: a failed write throws and leaves memory unchanged,
   * so the log stays the authority.
   *
   * @param entry - Event to persist.
   */
  append(entry: JournalEntry): void {
    const line = JSON.stringify(entry) + '\n'
    appendFileSync(this.filePath, line, 'utf8')
    this.lines += 1
    this.apply(entry)
    this.compactIfNeeded('threshold')
  }

  /**
   * Rewrite the journal as one snapshot entry of every retained ticket.
   *
   * Active tickets are always retained. A finished ticket is retained while it
   * is younger than the configured retention, so the board still shows recent
   * history. The replacement is written beside the journal and renamed over it,
   * so a failure leaves the previous log intact.
   *
   * @param now - Clock reading used for the retention cut-off.
   * @returns What was written, or undefined when the rewrite failed.
   */
  compact(now = Date.now()): CompactionResult | undefined {
    const cutoff = now - this.retentionMs
    const kept: Ticket[] = []
    const expired: Ticket[] = []
    for (const ticket of this.tickets.values()) {
      const finished = TERMINAL_STATUSES.has(ticket.status)
      if (finished && ticket.updatedAt < cutoff) expired.push(ticket)
      else kept.push(ticket)
    }

    const entry: JournalEntry = { type: 'snapshot', tickets: kept, at: now }
    const tempPath = `${this.filePath}.compact`
    try {
      writeFileSync(tempPath, `${JSON.stringify(entry)}\n`, 'utf8')
      renameSync(tempPath, this.filePath)
    } catch (error) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        // Best effort: the stale temp file is harmless and gets overwritten next time.
      }
      this.logger?.warn(`[Autoloop] Journal compaction failed, keeping the previous log: ${String(error)}`)
      return undefined
    }

    // Memory mirrors the rewritten log without rebuilding live tickets, so a run
    // already holding one keeps its identity; only expired rows leave the map.
    for (const ticket of expired) this.tickets.delete(ticket.id)
    this.lines = 1
    this.logger?.info(`[Autoloop] Journal compacted: ${kept.length} ticket(s) kept, ${expired.length} expired ticket(s) dropped`)
    return { lines: 1, kept: kept.length, dropped: expired.length }
  }

  /**
   * Compact when the log is long or expired history is still present.
   * @param reason - Diagnostic label for the trigger.
   */
  private compactIfNeeded(reason: 'boot' | 'threshold'): void {
    const cutoff = Date.now() - this.retentionMs
    const hasExpired = [...this.tickets.values()]
      .some(ticket => TERMINAL_STATUSES.has(ticket.status) && ticket.updatedAt < cutoff)
    if (this.lines < this.compactAfterLines && !hasExpired) return
    this.logger?.info(`[Autoloop] Compacting journal (${reason}: ${this.lines} lines)`)
    this.compact()
  }

  /** Replay whole journal from disk on boot */
  private replay(): void {
    if (!existsSync(this.filePath)) {
      return
    }
    const content = readFileSync(this.filePath, 'utf8')
    const lines = content.split('\n')
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.lines += 1
      try {
        this.apply(JSON.parse(trimmed) as JournalEntry)
      } catch (error) {
        // A torn trailing write is expected; anything else means lost history.
        // Keep replaying so one bad line cannot hide later state, but never stay silent.
        this.corrupt += 1
        this.logger?.warn(`[Autoloop] Skipped undecodable journal line ${index + 1}: ${String(error)}`)
      }
    }
  }

  /** Apply an entry into memory state machine */
  private apply(entry: JournalEntry): void {
    switch (entry.type) {
      case 'snapshot': {
        // A snapshot is a baseline: it owns the whole state, so stale rows go.
        this.tickets.clear()
        for (const ticket of entry.tickets) {
          const cloned = normalizeTicket(structuredClone(ticket))
          this.tickets.set(cloned.id, cloned)
        }
        break
      }
      case 'ticket.created': {
        const cloned = normalizeTicket(structuredClone(entry.ticket))
        this.tickets.set(cloned.id, cloned)
        break
      }
      case 'ticket.input_added': {
        const ticket = this.tickets.get(entry.ticketId)
        if (ticket) {
          ticket.inputs.push(structuredClone(entry.input))
          ticket.updatedAt = entry.at
        }
        break
      }
      case 'ticket.status_changed': {
        const ticket = this.tickets.get(entry.ticketId)
        if (ticket) {
          ticket.status = entry.status
          ticket.updatedAt = entry.at
        }
        break
      }
      case 'ticket.schedule_changed': {
        const ticket = this.tickets.get(entry.ticketId)
        if (ticket) {
          ticket.scheduleMode = migrateScheduleMode(entry.scheduleMode)
          if (entry.scheduledAt === null) delete ticket.scheduledAt
          else if (typeof entry.scheduledAt === 'number') ticket.scheduledAt = entry.scheduledAt
          if (entry.priority) ticket.priority = entry.priority
          ticket.updatedAt = entry.at
        }
        break
      }
      case 'ticket.assignment_started': {
        const ticket = this.tickets.get(entry.ticketId)
        if (ticket) {
          ticket.assignment = structuredClone(entry.assignment)
          ticket.status = 'running'
          ticket.updatedAt = entry.at
        }
        break
      }
      case 'ticket.assignment_ended': {
        const ticket = this.tickets.get(entry.ticketId)
        if (ticket && ticket.assignment) {
          ticket.assignment.endedAt = entry.at
          ticket.assignment.resultSummary = entry.resultSummary
          ticket.assignment.error = entry.error
          if (entry.sessionId) {
            ticket.assignment.sessionId = entry.sessionId
          }
          ticket.status = entry.error ? 'failed' : 'completed'
          ticket.updatedAt = entry.at
        }
        break
      }
      case 'ticket.attention_raised': {
        const ticket = this.tickets.get(entry.ticketId)
        if (ticket) {
          ticket.attention = structuredClone(entry.attention)
          ticket.status = 'waiting_attention'
          ticket.updatedAt = entry.at
        }
        break
      }
      case 'ticket.attention_resolved': {
        const ticket = this.tickets.get(entry.ticketId)
        if (ticket && ticket.attention) {
          ticket.attention.status = 'resolved'
          ticket.attention.resolvedAnswer = entry.answer
          ticket.attention.resolvedAt = entry.at
          ticket.status = 'running'
          ticket.updatedAt = entry.at
        }
        break
      }
    }
  }
}
