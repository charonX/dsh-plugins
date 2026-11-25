/**
 * The pipeline core: a pipeline is an ordered stage sequence a ticket walks
 * through. Each stage references a crew member and carries its own
 * instruction; a stage may be skippable with a skip-logic prompt the Steward
 * reads when deciding whether to skip it. Stages are immutable snapshots of
 * references — the member card itself stays editable.
 */
import { z } from 'zod'

/** Execution semantics of a pipeline stage (`review` stages stay read-only on source and return failures upstream). */
export const STAGE_MODES = ['execute', 'review'] as const
export type StageMode = (typeof STAGE_MODES)[number]

/** Optional per-pipeline or per-stage prompt section overrides (`sections: { [sectionId]: text }`). */
export const promptScopeOverrideSchema = z.object({
  sections: z.record(z.string().trim().min(1), z.string()).optional(),
})

export type PromptScopeOverride = z.infer<typeof promptScopeOverrideSchema>

/** One pipeline stage: who does it, with what instruction, and how it may skip. */
export const pipelineStage = z.object({
  /** The referenced crew member's id. */
  memberId: z.string().min(1),
  /** The stage's own instruction, appended to the member's duty prompt. */
  instruction: z.string().trim().max(4000).default(''),
  /** Whether the Steward may skip this stage. */
  skippable: z.boolean().default(false),
  /** When skippable: the skip-logic prompt guiding the Steward's decision. */
  skipLogic: z.string().trim().max(2000).optional(),
  /** Optional stage mode; `'review'` runs read-only against code and returns failures to the prior implementation stage. */
  mode: z.enum(STAGE_MODES).optional(),
  /** Optional stage-level prompt section overrides. */
  prompt: promptScopeOverrideSchema.optional(),
})

export type PipelineStage = z.infer<typeof pipelineStage>

/** One pipeline: the named ordered stage sequence. */
export const pipelineRecord = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(40),
  stages: z.array(pipelineStage),
  /** Optional pipeline-level prompt section overrides. */
  prompt: promptScopeOverrideSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type PipelineRecord = z.infer<typeof pipelineRecord>
