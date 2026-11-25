/**
 * Wire-level types and input schemas for the Prompt Studio & team-config
 * prompt registry/preview/import/save endpoints — shared by Host and Client.
 */
import { z as zod } from 'zod'
import { TURN_IDS, type TurnId } from '../prompt/prompt-sections.ts'
import type { GlobalPromptsConfig, PromptOverrideSource, PromptSectionsMap } from '../prompt/prompt-resolve.ts'
import type { PromptVariableDef } from '../prompt/prompt-vars.ts'
import type { TeamConfigStatusView } from './team-config-core.ts'
import { PRESET_IDS } from './presets.ts'

export interface PromptRegistrySectionView {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly defaultText: string
  readonly locked: boolean
  readonly variants?: Readonly<Record<string, string>>
}

export interface PromptRegistryDataBlockView {
  readonly id: string
  readonly label: string
  readonly description: string
}

export interface PromptRegistryTurnView {
  readonly id: TurnId
  readonly label: string
  readonly description: string
  readonly scopeConfigurable: boolean
  readonly sections: readonly PromptRegistrySectionView[]
  readonly dataBlocks: readonly PromptRegistryDataBlockView[]
}

export interface PromptRegistryStageView {
  readonly index: number
  readonly memberId: string
  readonly memberName: string
  readonly memberAgentKind?: string
  readonly mode?: 'execute' | 'review'
  readonly prompt?: PromptSectionsMap
}

export interface PromptRegistryPipelineView {
  readonly id: string
  readonly name: string
  readonly prompt?: PromptSectionsMap
  readonly stages: readonly PromptRegistryStageView[]
}

export interface PromptRegistryView {
  readonly turns: readonly PromptRegistryTurnView[]
  readonly variables: readonly PromptVariableDef[]
  readonly globalPrompts?: GlobalPromptsConfig
  readonly pipelines: readonly PromptRegistryPipelineView[]
  readonly yaml: string
  readonly status: TeamConfigStatusView
}

export const promptSaveInputSchema = zod.object({
  scope: zod.enum(['global', 'pipeline', 'stage']),
  turnId: zod.enum(TURN_IDS).optional(),
  pipelineId: zod.string().min(1).optional(),
  stageIndex: zod.number().int().min(0).optional(),
  /** Map of sectionId -> override text, or `null` to clear override and restore inherited/default. */
  sections: zod.record(zod.string().min(1), zod.string().nullable()),
})

export type PromptSaveInput = zod.infer<typeof promptSaveInputSchema>

export const teamConfigImportYamlInputSchema = zod.object({
  yaml: zod.string(),
})

export type TeamConfigImportYamlInput = zod.infer<typeof teamConfigImportYamlInputSchema>

export const promptPreviewInputSchema = zod.object({
  turnId: zod.enum(TURN_IDS),
  pipelineId: zod.string().min(1).optional(),
  stageIndex: zod.number().int().min(0).optional(),
  projectId: zod.string().min(1).optional(),
  ticketId: zod.string().min(1).optional(),
  draftSections: zod.record(zod.string().min(1), zod.string().nullable()).optional(),
})

export type PromptPreviewInput = zod.infer<typeof promptPreviewInputSchema>

export interface PromptPreviewSectionView {
  readonly id: string
  readonly label: string
  readonly text: string
  readonly defaultText: string
  readonly source: PromptOverrideSource
  readonly locked: boolean
}

export interface PromptPreviewView {
  readonly turnId: TurnId
  readonly text: string
  readonly truncated: boolean
  readonly sections: readonly PromptPreviewSectionView[]
  readonly missingVars: readonly string[]
  readonly unknownVars: readonly string[]
  readonly resolvedProject?: {
    readonly id: string
    readonly name: string
    readonly root: string
  }
}

export const presetApplyInputSchema = zod.object({
  presetId: zod.enum(PRESET_IDS),
})

export type PresetApplyInput = zod.infer<typeof presetApplyInputSchema>
