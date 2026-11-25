/**
 * Wire-level types and input schemas of the attention API — shared by the
 * Host service and the client contribution.
 */
import { z as zod } from 'zod'
import type { AttentionRecord } from './attention-core.ts'

/** One attention as the wire sees it. */
export type AttentionView = Readonly<AttentionRecord>

export const attentionListInputSchema = zod.object({
  ticketId: zod.string().min(1).optional(),
})

export type AttentionListInput = zod.infer<typeof attentionListInputSchema>

export const attentionAnswerInputSchema = zod.object({
  attentionId: zod.string().min(1),
  /** The user's answer, delivered verbatim to the Executor Session. */
  answer: zod.string().min(1),
})

export type AttentionAnswerInput = zod.infer<typeof attentionAnswerInputSchema>
