/**
 * Wire-level types and input schemas of the pipeline API — shared by the
 * host service and the client contribution.
 */
import { z as zod } from 'zod'
import { pipelineStage, STAGE_MODES } from './pipeline-core.ts'
import type { PipelineRecord } from './pipeline-core.ts'

export type PipelineView = PipelineRecord

/** One stage as the form submits it. */
export const pipelineStageInputSchema = zod.object({
  memberId: zod.string().min(1),
  instruction: zod.string().trim().max(4000).optional(),
  skippable: zod.boolean().optional(),
  skipLogic: zod.string().trim().max(2000).optional(),
  mode: zod.enum(STAGE_MODES).optional(),
})

export type PipelineStageInput = zod.infer<typeof pipelineStageInputSchema>

export const pipelineInputSchema = zod.object({
  name: zod.string().trim().min(1).max(40),
  stages: zod.array(pipelineStageInputSchema).min(1),
})

export type PipelineInput = zod.infer<typeof pipelineInputSchema>

export const pipelineIdSchema = zod.object({
  pipelineId: zod.string().min(1),
})

export type PipelineIdInput = zod.infer<typeof pipelineIdSchema>

export const pipelineUpdateInputSchema = pipelineIdSchema.extend(pipelineInputSchema.partial().shape)

export type PipelineUpdateInput = zod.infer<typeof pipelineUpdateInputSchema>
