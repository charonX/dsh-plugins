/**
 * Autoloop microkernel engine.
 * Deterministic finite state machine: event ingestion, hop limit, thread deduplication,
 * zero-cost suspension, and closed-loop execution.
 *
 * Admission timing has exactly two knobs, both owned by configuration:
 * the off-peak window (`offpeak` tickets wait for it) and the concurrency
 * ceiling (due tickets beyond it wait for a free slot). See
 * {@link module:@charonx/dsh-autoloop/shared/schedule}.
 *
 * @module @charonx/dsh-autoloop/core/kernel
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentExecutor,
  ApprovalChannel,
  AttentionRequest,
  IngressEvent,
  JournalLogger,
  KernelStateSnapshot,
  OffpeakWindow,
  Ticket,
} from '../shared/types.js'
import {
  DEFAULT_OFFPEAK_WINDOW,
  describeOffpeakView,
  isWithinOffpeak,
  resolveSchedule,
} from '../shared/schedule.js'
import { IntentRouter } from './router.js'
import { JournalStore } from './store.js'

export interface KernelOptions {
  store: JournalStore
  router: IntentRouter
  maxHops?: number
  defaultWorkspacePath: string
  /** Configured off-peak window; defaults to {@link DEFAULT_OFFPEAK_WINDOW}. */
  offpeak?: OffpeakWindow
  /** Maximum tickets executing at once; defaults to 2. */
  maxConcurrent?: number
  logger?: JournalLogger
}

/** Interval between admission sweeps, in milliseconds. */
const DRAIN_INTERVAL_MS = 20_000

/** Default page size of the Done column. */
export const DEFAULT_DONE_PAGE = 100

/** Largest Done page the board may request. */
export const MAX_DONE_PAGE = 500

export class AutoloopKernel {
  public readonly maxHops: number
  /** Window `offpeak` tickets wait for; read by every timing surface. */
  public readonly offpeak: OffpeakWindow
  /** Ceiling on tickets executing at once. */
  public readonly maxConcurrent: number
  private readonly store: JournalStore
  private readonly router: IntentRouter
  private readonly channels = new Set<ApprovalChannel>()
  private executor?: AgentExecutor
  private activeControllers = new Map<string, AbortController>()
  private running = true
  private scheduleCheckTimer?: ReturnType<typeof setInterval>

  constructor(private readonly options: KernelOptions) {
    this.store = options.store
    this.router = options.router
    this.maxHops = options.maxHops ?? 8
    this.offpeak = options.offpeak ?? DEFAULT_OFFPEAK_WINDOW
    this.maxConcurrent = Math.max(1, Math.trunc(options.maxConcurrent ?? 2))

    // Periodically admit due tickets: window entry, elapsed schedules, free slots.
    this.scheduleCheckTimer = setInterval(() => {
      void this.drainPendingTickets()
    }, DRAIN_INTERVAL_MS)
    // Never keep a host process alive on behalf of the admission sweep.
    this.scheduleCheckTimer.unref?.()
  }

  /** Register an approval channel (e.g. Feishu card, Desktop notifications) */
  registerChannel(channel: ApprovalChannel): () => void {
    this.channels.add(channel)
    return () => this.channels.delete(channel)
  }

  /** Register the agent executor adapter (e.g. dsh agent executor) */
  registerExecutor(executor: AgentExecutor): () => void {
    this.executor = executor
    // A previous process may have died mid-dispatch: requeue before admitting.
    this.recoverInterrupted()
    // Kick off dispatch for any pending tickets loaded from store
    void this.drainPendingTickets()
    return () => {
      if (this.executor === executor) {
        this.executor = undefined
      }
    }
  }

  /**
   * Board state for the monitor.
   *
   * Stats cover every ticket. `active` is returned whole (it is bounded by the
   * concurrency ceiling plus suspended work); finished tickets are paged so a
   * long-running deployment cannot push an unbounded payload on every poll.
   *
   * @param options - Done-column page size and offset.
   * @returns Stats, active tickets, one Done page, and the timing surfaces.
   */
  getStateSnapshot(options: { doneLimit?: number; doneOffset?: number } = {}): KernelStateSnapshot {
    const all = this.store.getAllTickets()
    let pendingCount = 0
    let runningCount = 0
    let attentionCount = 0
    let completedCount = 0
    let failedCount = 0
    const active: Ticket[] = []
    const done: Ticket[] = []

    for (const ticket of all) {
      switch (ticket.status) {
        case 'pending': pendingCount += 1; active.push(ticket); break
        case 'running': runningCount += 1; active.push(ticket); break
        case 'waiting_attention': attentionCount += 1; active.push(ticket); break
        case 'completed': completedCount += 1; done.push(ticket); break
        default: failedCount += 1; done.push(ticket); break
      }
    }

    const doneLimit = Math.min(MAX_DONE_PAGE, Math.max(1, Math.trunc(options.doneLimit ?? DEFAULT_DONE_PAGE)))
    const doneOffset = Math.max(0, Math.trunc(options.doneOffset ?? 0))
    active.sort((a, b) => b.createdAt - a.createdAt)
    done.sort((a, b) => b.updatedAt - a.updatedAt)

    return {
      stats: {
        totalTickets: all.length,
        pendingCount,
        runningCount,
        attentionCount,
        completedCount,
        failedCount,
      },
      active,
      done: done.slice(doneOffset, doneOffset + doneLimit),
      doneTotal: done.length,
      maxHops: this.maxHops,
      offpeak: describeOffpeakView(new Date(), this.offpeak),
      limits: { maxConcurrent: this.maxConcurrent, runningCount },
    }
  }

  /** Ingest external or manual event into kernel */
  async ingestEvent(event: IngressEvent): Promise<{ action: 'fanned_out' | 'ticket_created' | 'circuit_broken'; ticketId: string }> {
    const now = Date.now()
    const hopCount = event.hopCount ?? 0

    // 0. The router resolves the mandate; timing is validated here so no ingress
    //    path can persist an unhonorable schedule. Throws ScheduleInputError.
    const mandate = this.router.route(event)
    const schedule = resolveSchedule(mandate.scheduleMode, mandate.scheduledAt, now)

    // 1. Hop limit circuit breaker
    if (hopCount >= this.maxHops) {
      this.options.logger?.warn(`[Autoloop] Hop limit reached (${hopCount} >= ${this.maxHops}) for thread ${event.threadId}`)
      const ticketId = `ticket-${randomUUID().slice(0, 8)}`
      const brokenTicket: Ticket = {
        id: ticketId,
        threadId: event.threadId,
        title: event.summary,
        source: mandate.triage?.detectedSource ?? event.source,
        status: 'circuit_broken',
        priority: mandate.priority ?? 'p2',
        scheduleMode: schedule.mode,
        ...(schedule.scheduledAt === undefined ? {} : { scheduledAt: schedule.scheduledAt }),
        tags: mandate.tags ?? [],
        mandate,
        triage: mandate.triage,
        workspace: { sourceRoot: mandate.workspacePath },
        inputs: [],
        hopCount,
        createdAt: now,
        updatedAt: now,
      }
      this.store.append({ type: 'ticket.created', ticket: brokenTicket, at: now })
      return { action: 'circuit_broken', ticketId }
    }

    // 2. Thread deduplication & Fan-out
    const activeTicket = this.store.findActiveTicketOnThread(event.threadId)
    if (activeTicket) {
      const inputId = `in-${randomUUID().slice(0, 8)}`
      const input = {
        id: inputId,
        eventId: event.id,
        text: event.summary,
        receivedAt: now,
      }
      this.store.append({
        type: 'ticket.input_added',
        ticketId: activeTicket.id,
        input,
        at: now,
      })
      this.options.logger?.info(`[Autoloop] Fanned-out input into active ticket ${activeTicket.id} on thread ${event.threadId}`)
      return { action: 'fanned_out', ticketId: activeTicket.id }
    }

    // 3. Create fresh Ticket
    const ticketId = `ticket-${randomUUID().slice(0, 8)}`
    const newTicket: Ticket = {
      id: ticketId,
      threadId: event.threadId,
      title: event.summary,
      source: mandate.triage?.detectedSource ?? event.source,
      status: 'pending',
      priority: mandate.priority ?? 'p2',
      scheduleMode: schedule.mode,
      ...(schedule.scheduledAt === undefined ? {} : { scheduledAt: schedule.scheduledAt }),
      tags: mandate.tags ?? [],
      mandate,
      triage: mandate.triage,
      workspace: { sourceRoot: mandate.workspacePath },
      inputs: [],
      hopCount,
      createdAt: now,
      updatedAt: now,
    }

    this.store.append({ type: 'ticket.created', ticket: newTicket, at: now })
    this.options.logger?.info(`[Autoloop] Created ticket ${ticketId} for thread ${event.threadId}`)

    // Trigger dispatch asynchronously
    void this.drainPendingTickets()
    return { action: 'ticket_created', ticketId }
  }

  /** Raise attention (human decision required) from an agent */
  async raiseAttention(ticketId: string, attention: Omit<AttentionRequest, 'id' | 'ticketId' | 'status' | 'createdAt'>): Promise<void> {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`)

    const now = Date.now()
    const request: AttentionRequest = {
      id: `attn-${randomUUID().slice(0, 8)}`,
      ticketId,
      title: attention.title,
      question: attention.question,
      detail: attention.detail,
      options: attention.options,
      status: 'pending',
      createdAt: now,
    }

    // Abort active controller for zero-cost suspension
    const controller = this.activeControllers.get(ticketId)
    if (controller) {
      controller.abort()
      this.activeControllers.delete(ticketId)
    }

    this.store.append({ type: 'ticket.attention_raised', ticketId, attention: request, at: now })
    this.options.logger?.info(`[Autoloop] Attention raised on ticket ${ticketId}, execution suspended`)

    // Broadcast attention to channels
    for (const channel of this.channels) {
      try {
        await channel.sendAttention(request)
      } catch (err) {
        this.options.logger?.warn(`[Autoloop] Failed to broadcast attention to channel ${channel.name}: ${String(err)}`)
      }
    }
  }

  /** Resolve attention with human answer and resume execution */
  async resolveAttention(ticketId: string, answer: string): Promise<void> {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket || ticket.status !== 'waiting_attention') {
      throw new Error(`Ticket ${ticketId} is not waiting for attention`)
    }

    const now = Date.now()
    this.store.append({ type: 'ticket.attention_resolved', ticketId, answer, at: now })
    this.options.logger?.info(`[Autoloop] Attention resolved on ticket ${ticketId} with answer: ${answer}`)

    // Resume execution
    void this.dispatchTicket(ticketId)
  }

  /**
   * Requeue tickets left `running` by a previous process.
   *
   * The journal commits `assignment_started` before the executor runs, so a
   * crash leaves the ticket running with no live controller and no future
   * admission. Called once, when the executor becomes available and before the
   * first sweep.
   *
   * @returns How many tickets were requeued.
   */
  recoverInterrupted(): number {
    if (!this.running) return 0
    const orphaned = this.store.getAllTickets()
      .filter(ticket => ticket.status === 'running' && !this.activeControllers.has(ticket.id))
    for (const ticket of orphaned) {
      this.store.append({ type: 'ticket.status_changed', ticketId: ticket.id, status: 'pending', at: Date.now() })
    }
    if (orphaned.length > 0) {
      this.options.logger?.warn(`[Autoloop] Requeued ${orphaned.length} ticket(s) interrupted by a previous run`)
    }
    return orphaned.length
  }

  /**
   * Change a queued ticket's timing.
   *
   * Only a `pending` ticket may be rescheduled: a running or suspended ticket
   * already owns its execution, and a finished one has nothing left to time.
   *
   * @param ticketId - Ticket to reschedule.
   * @param mode - Requested mode, validated like an ingress payload.
   * @param scheduledAt - Requested instant for `scheduled`.
   * @returns False when the ticket is missing or not pending.
   * @throws ScheduleInputError when the timing cannot be honored.
   */
  async rescheduleTicket(ticketId: string, mode: unknown, scheduledAt?: unknown): Promise<boolean> {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket || ticket.status !== 'pending') return false
    const decision = resolveSchedule(mode, scheduledAt, Date.now())
    this.store.append({
      type: 'ticket.schedule_changed',
      ticketId,
      scheduleMode: decision.mode,
      scheduledAt: decision.scheduledAt ?? null,
      at: Date.now(),
    })
    this.options.logger?.info(`[Autoloop] Ticket ${ticketId} rescheduled to ${decision.mode}`)
    await this.drainPendingTickets()
    return true
  }

  /**
   * Requeue one failed or circuit-broken ticket, keeping its timing plan.
   * @param ticketId - Ticket to retry.
   * @returns False when the ticket is missing or its status is not retryable.
   */
  async retryTicket(ticketId: string): Promise<boolean> {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) return false
    if (ticket.status !== 'failed' && ticket.status !== 'circuit_broken') return false
    this.store.append({ type: 'ticket.status_changed', ticketId, status: 'pending', at: Date.now() })
    this.options.logger?.info(`[Autoloop] Ticket ${ticketId} requeued for retry`)
    await this.drainPendingTickets()
    return true
  }

  /** Whether the ticket's timing allows it to start right now. */
  private isDue(ticket: Ticket, now: Date): boolean {
    if (ticket.scheduleMode === 'offpeak') return isWithinOffpeak(now, this.offpeak)
    if (ticket.scheduleMode === 'scheduled' && ticket.scheduledAt !== undefined) {
      return now.getTime() >= ticket.scheduledAt
    }
    return true
  }

  /** Drain pending tickets honoring priority, timing, and the concurrency ceiling */
  private async drainPendingTickets(): Promise<void> {
    if (!this.running || !this.executor) return
    const all = this.store.getAllTickets()
    const priorityRank: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

    const capacity = this.maxConcurrent - all.filter(t => t.status === 'running').length
    if (capacity <= 0) return

    const pending = all
      .filter(t => t.status === 'pending')
      .sort((a, b) => {
        const rankA = priorityRank[a.priority ?? 'p2'] ?? 2
        const rankB = priorityRank[b.priority ?? 'p2'] ?? 2
        if (rankA !== rankB) return rankA - rankB
        return a.createdAt - b.createdAt
      })

    const now = new Date()
    let started = 0
    for (const ticket of pending) {
      if (started >= capacity) break
      if (!this.isDue(ticket, now)) continue
      started += 1
      void this.dispatchTicket(ticket.id)
    }
  }

  /**
   * Run one ticket now.
   *
   * Bypasses the window and schedule wait without rewriting the ticket's plan,
   * so a manual run never loses the configured timing. Failed and
   * circuit-broken tickets are requeued first.
   *
   * @param ticketId - Ticket to start.
   * @returns False when the ticket is missing or is not startable.
   */
  async runTicketNow(ticketId: string): Promise<boolean> {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) return false
    const retryable = ticket.status === 'failed' || ticket.status === 'circuit_broken'
    if (ticket.status !== 'pending' && !retryable) return false
    if (retryable) {
      this.store.append({ type: 'ticket.status_changed', ticketId, status: 'pending', at: Date.now() })
    }

    this.options.logger?.info(`[Autoloop] Ticket ${ticketId} manually triggered for immediate execution`)
    void this.dispatchTicket(ticketId)
    return true
  }

  /** Dispatch an individual ticket */
  private async dispatchTicket(ticketId: string): Promise<void> {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket || !this.executor) return
    if (ticket.status !== 'pending' && ticket.status !== 'running') return
    // One live execution per ticket: never overwrite an in-flight assignment.
    if (this.activeControllers.has(ticketId)) return

    const now = Date.now()
    const assignmentId = `assign-${randomUUID().slice(0, 8)}`
    this.store.append({
      type: 'ticket.assignment_started',
      ticketId,
      assignment: { assignmentId, startedAt: now },
      at: now,
    })

    const controller = new AbortController()
    this.activeControllers.set(ticketId, controller)

    try {
      const result = await this.executor.execute(ticket, controller.signal)
      this.activeControllers.delete(ticketId)

      // If aborted during suspension, state is already waiting_attention, do not complete
      const current = this.store.getTicket(ticketId)
      if (current?.status === 'waiting_attention') {
        return
      }

      this.store.append({
        type: 'ticket.assignment_ended',
        ticketId,
        resultSummary: result.summary,
        error: result.error,
        sessionId: result.sessionId,
        at: Date.now(),
      })
    } catch (err: unknown) {
      this.activeControllers.delete(ticketId)
      const current = this.store.getTicket(ticketId)
      if (current?.status === 'waiting_attention') {
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      this.store.append({
        type: 'ticket.assignment_ended',
        ticketId,
        error: message,
        at: Date.now(),
      })
    }
  }

  /** Shutdown kernel */
  stop(): void {
    this.running = false
    if (this.scheduleCheckTimer) {
      clearInterval(this.scheduleCheckTimer)
      this.scheduleCheckTimer = undefined
    }
    for (const controller of this.activeControllers.values()) {
      controller.abort()
    }
    this.activeControllers.clear()
  }
}
