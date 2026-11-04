/**
 * Autoloop microkernel engine.
 * Deterministic finite state machine: event ingestion, hop limit, thread deduplication,
 * zero-cost suspension, and closed-loop execution.
 *
 * @module @charonx/dsh-autoloop/core/kernel
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentExecutor,
  ApprovalChannel,
  AttentionRequest,
  IngressEvent,
  KernelStateSnapshot,
  Ticket,
} from '../shared/types.js'
import { IntentRouter } from './router.js'
import { JournalStore } from './store.js'

export interface KernelOptions {
  store: JournalStore
  router: IntentRouter
  maxHops?: number
  defaultWorkspacePath: string
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
}

export class AutoloopKernel {
  public readonly maxHops: number
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

    // Periodically check for scheduled tickets or nightly window entry
    this.scheduleCheckTimer = setInterval(() => {
      void this.drainPendingTickets()
    }, 20_000)
  }

  /** Register an approval channel (e.g. Feishu card, Desktop notifications) */
  registerChannel(channel: ApprovalChannel): () => void {
    this.channels.add(channel)
    return () => this.channels.delete(channel)
  }

  /** Register the agent executor adapter (e.g. dsh agent executor) */
  registerExecutor(executor: AgentExecutor): () => void {
    this.executor = executor
    // Kick off dispatch for any pending tickets loaded from store
    void this.drainPendingTickets()
    return () => {
      if (this.executor === executor) {
        this.executor = undefined
      }
    }
  }

  /** Get snapshot of kernel state for UI and inspection */
  getStateSnapshot(): KernelStateSnapshot {
    const all = this.store.getAllTickets()
    let pendingCount = 0
    let runningCount = 0
    let attentionCount = 0
    let completedCount = 0
    let failedCount = 0

    for (const t of all) {
      if (t.status === 'pending') pendingCount++
      else if (t.status === 'running') runningCount++
      else if (t.status === 'waiting_attention') attentionCount++
      else if (t.status === 'completed') completedCount++
      else if (t.status === 'failed' || t.status === 'circuit_broken') failedCount++
    }

    return {
      stats: {
        totalTickets: all.length,
        pendingCount,
        runningCount,
        attentionCount,
        completedCount,
        failedCount,
      },
      tickets: all.sort((a, b) => b.createdAt - a.createdAt),
      maxHops: this.maxHops,
    }
  }

  /** Ingest external or manual event into kernel */
  async ingestEvent(event: IngressEvent): Promise<{ action: 'fanned_out' | 'ticket_created' | 'circuit_broken'; ticketId: string }> {
    const now = Date.now()
    const hopCount = event.hopCount ?? 0

    // 1. Hop limit circuit breaker
    if (hopCount >= this.maxHops) {
      this.options.logger?.warn(`[Autoloop] Hop limit reached (${hopCount} >= ${this.maxHops}) for thread ${event.threadId}`)
      const ticketId = `ticket-${randomUUID().slice(0, 8)}`
      const mandate = this.router.route(event)
      const brokenTicket: Ticket = {
        id: ticketId,
        threadId: event.threadId,
        title: event.summary,
        source: event.source,
        status: 'circuit_broken',
        priority: mandate.priority ?? 'p2',
        scheduleMode: mandate.scheduleMode ?? 'immediate',
        scheduledAt: mandate.scheduledAt,
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
    const mandate = this.router.route(event)
    const newTicket: Ticket = {
      id: ticketId,
      threadId: event.threadId,
      title: event.summary,
      source: event.source,
      status: 'pending',
      priority: mandate.priority ?? 'p2',
      scheduleMode: mandate.scheduleMode ?? 'immediate',
      scheduledAt: mandate.scheduledAt,
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

  /** Check if current hour falls within off-peak nightly window (23:00 to 07:00) */
  private isNightlyWindow(): boolean {
    const hour = new Date().getHours()
    return hour >= 23 || hour < 7
  }

  /** Drain all pending tickets honoring priority ranking and schedule timing */
  private async drainPendingTickets(): Promise<void> {
    if (!this.running || !this.executor) return
    const all = this.store.getAllTickets()
    const priorityRank: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

    const pending = all
      .filter(t => t.status === 'pending')
      .sort((a, b) => {
        const rankA = priorityRank[a.priority ?? 'p2'] ?? 2
        const rankB = priorityRank[b.priority ?? 'p2'] ?? 2
        if (rankA !== rankB) return rankA - rankB
        return a.createdAt - b.createdAt
      })

    const inNightly = this.isNightlyWindow()
    const now = Date.now()

    for (const ticket of pending) {
      // 1. If nightly execution is specified and current time is not yet off-peak, defer
      if (ticket.scheduleMode === 'nightly' && !inNightly) {
        continue
      }
      // 2. If scheduled time is in the future, defer
      if (ticket.scheduleMode === 'scheduled' && ticket.scheduledAt && now < ticket.scheduledAt) {
        continue
      }
      void this.dispatchTicket(ticket.id)
    }
  }

  /** Manually trigger immediate execution of a pending/scheduled/nightly ticket */
  async runTicketNow(ticketId: string): Promise<boolean> {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) return false
    if (ticket.status !== 'pending') return false

    const now = Date.now()
    this.store.append({
      type: 'ticket.schedule_changed',
      ticketId,
      scheduleMode: 'immediate',
      at: now,
    })
    this.options.logger?.info(`[Autoloop] Ticket ${ticketId} manually triggered for immediate execution`)
    void this.dispatchTicket(ticketId)
    return true
  }

  /** Dispatch an individual ticket */
  private async dispatchTicket(ticketId: string): Promise<void> {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket || !this.executor) return
    if (ticket.status !== 'pending' && ticket.status !== 'running') return

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
