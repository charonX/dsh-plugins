/**
 * Event-sourcing journal store for Autoloop microkernel.
 * Persists append-only logs in jsonl format and reconstructs memory state on reboot.
 *
 * @module @charonx/dsh-autoloop/core/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { JournalEntry, Ticket } from '../shared/types.js'

export class JournalStore {
  private readonly tickets = new Map<string, Ticket>()

  constructor(public readonly filePath: string) {
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    this.replay()
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

  /** Append entry to log file and apply to in-memory state */
  append(entry: JournalEntry): void {
    this.apply(entry)
    const line = JSON.stringify(entry) + '\n'
    appendFileSync(this.filePath, line, 'utf8')
  }

  /** Replay whole journal from disk on boot */
  private replay(): void {
    if (!existsSync(this.filePath)) {
      return
    }
    const content = readFileSync(this.filePath, 'utf8')
    const lines = content.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const entry = JSON.parse(trimmed) as JournalEntry
        this.apply(entry)
      } catch {
        // Skip corrupted or half-written trailing lines safely
      }
    }
  }

  /** Apply an entry into memory state machine */
  private apply(entry: JournalEntry): void {
    switch (entry.type) {
      case 'ticket.created': {
        const cloned = structuredClone(entry.ticket)
        if (!cloned.priority) cloned.priority = 'p2'
        if (!cloned.scheduleMode) cloned.scheduleMode = 'immediate'
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
          ticket.scheduleMode = entry.scheduleMode
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
