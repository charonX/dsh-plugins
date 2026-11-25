import { z } from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable decision-record identity. */
export type DecisionId = Branded<'DecisionId'>

/**
 * One decision the main Session made through its decision tool. Every
 * decision lands in this table verbatim — the audit trail of the Steward.
 */
export const decisionRecord = z.object({
  id: z.string(),
  /** The eval the decision belonged to. */
  evalId: z.string(),
  /** The Thread the decision was about. */
  threadId: z.string(),
  /**
   * The decision verb: the tool carried `accept` / `stop` / `ignore`; the
   * system itself records `incomplete` for a batch retired without a model
   * decision (repeated inconclusive runs or a policy change).
   */
  action: z.enum(['accept', 'stop', 'ignore', 'incomplete']),
  /** Evidence strength: how explicitly the triggers supported the action. */
  strength: z.enum(['explicit', 'inferred']).default('inferred'),
  /** What the acceptance covers, when accepting. */
  scope: z.string().optional(),
  /** The would-be ticket title, when accepting. */
  title: z.string().optional(),
  /** Existing ticket ID that already covers/resolves this thread, when ignoring. */
  supersededBy: z.string().optional(),
  /** The policy version the decision ran under. */
  policyVersion: z.string(),
  /** Free-form rationale from the model, kept verbatim. */
  rationale: z.string(),
  /** Epoch millis of the decision. */
  decidedAt: z.number(),
})

export type DecisionRecord = z.infer<typeof decisionRecord>

/** Durable decision records — the main Session's audit trail. */
export const decisionsDomain = defineDomain({
  name: 'dsh_manager_decisions',
  version: 1,
  tables: {
    decisions: domainTable<DecisionId, DecisionRecord>(decisionRecord),
  },
})
