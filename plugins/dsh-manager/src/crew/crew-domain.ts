/**
 * The crew domain: role cards over storage-domain — the persistence adapter
 * behind the crew core (ADR-0003).
 */
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { crewMember, type CrewMember } from './crew-core.ts'

/** Stable crew-member identity. */
export type CrewMemberId = Branded<'CrewMemberId'>

/** Durable crew state: one mutable record per member. */
export const crewDomain = defineDomain({
  name: 'dsh_manager_crew',
  version: 1,
  tables: {
    members: domainTable<CrewMemberId, CrewMember>(crewMember),
  },
})
