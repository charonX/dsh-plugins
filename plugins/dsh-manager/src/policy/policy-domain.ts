/**
 * The policy domain: immutable Policy versions over storage-domain — the
 * persistence adapter behind the policy core (ADR-0003).
 */
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { policyRecord, type PolicyRecord } from './policy-core.ts'

/** Stable Policy version identity (the version string itself). */
export type PolicyVersion = Branded<'PolicyVersion'>

/**
 * Durable Policy state. Versions are immutable records; the newest one is
 * the policy in force, and older ones stay for the history diff.
 */
export const policyDomain = defineDomain({
  name: 'dsh_manager_policy',
  version: 1,
  tables: {
    versions: domainTable<PolicyVersion, PolicyRecord>(policyRecord),
  },
})
