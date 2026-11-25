/**
 * The subscription core: a ticket subscribes to the Thread it originated
 * from. New triggers on that Thread fan out to the subscribed ticket as
 * context — they never run through an Eval, and the fan-in is derived at
 * read time from the durable trigger records, so delivery is idempotent.
 */
import type { TicketRecord } from '../board-domain.ts'

/** One fanned-in trigger, as a ticket card sees it. */
export interface FanItem {
  readonly id: string
  readonly externalKey: string
  readonly url: string
  readonly occurredAt?: number
  readonly collectedAt: number
}

/** The minimal trigger fact the fan-in derivation needs. */
export interface FanTrigger {
  readonly id: string
  readonly externalKey: string
  readonly url: string
  // `| undefined` keeps zod-inferred records (whose optional fields read as
  // `number | undefined`) assignable under exactOptionalPropertyTypes.
  readonly occurredAt?: number | undefined
  readonly collectedAt: number
}

/**
 * Derive the fan-in of one ticket: the thread's triggers that the accepting
 * Eval's batch did not cover, newest first. An ended ticket no longer
 * receives context; the list is capped so a chatty thread cannot bloat a card.
 * @param ticket - the subscribed ticket.
 * @param acceptedTriggerIds - the trigger ids of the Eval that minted the ticket.
 * @param threadTriggers - the thread's triggers, newest first.
 * @param limit - the maximum items returned.
 * @returns the fan-in items in newest-first order.
 */
export function fanInViewOf(
  ticket: Pick<TicketRecord, 'threadId' | 'state'>,
  acceptedTriggerIds: readonly string[],
  threadTriggers: readonly FanTrigger[],
  limit = 20,
): readonly FanItem[] {
  if (ticket.state === 'ended' || ticket.threadId === '') return []
  const batch = new Set(acceptedTriggerIds)
  return threadTriggers
    .filter(trigger => !batch.has(trigger.id))
    .slice(0, limit)
    .map((trigger): FanItem => ({
      id: trigger.id,
      externalKey: trigger.externalKey,
      url: trigger.url,
      ...(trigger.occurredAt === undefined ? {} : { occurredAt: trigger.occurredAt }),
      collectedAt: trigger.collectedAt,
    }))
}
