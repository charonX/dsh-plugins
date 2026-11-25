/**
 * Three-tier prompt section resolution and override validation:
 *   stage > pipeline > global > builtin
 * Enforces locked contract sections, unknown turn/section checks, unknown
 * variable checks, and per-section character caps before any config write.
 */
import {
  LOCKED_SECTION_IDS,
  SCOPE_CONFIGURABLE_SECTION_IDS,
  TURN_REGISTRY,
  isTurnId,
  type PromptSectionDef,
  type TurnId,
} from './prompt-sections.ts'
import { validateTemplateVariables } from './prompt-vars.ts'

export const MAX_PROMPT_SECTION_CHARS = 4000

export type PromptOverrideSource = 'builtin' | 'global' | 'pipeline' | 'stage'

export interface PromptSectionsMap {
  readonly sections?: Readonly<Record<string, string>> | undefined
}

export interface GlobalPromptsConfig {
  readonly turns?: Readonly<Partial<Record<TurnId, PromptSectionsMap>> & Record<string, PromptSectionsMap | undefined>> | undefined
}

export interface ResolvedPromptSection {
  readonly id: string
  readonly label: string
  readonly text: string
  readonly defaultText: string
  readonly source: PromptOverrideSource
  readonly locked: boolean
  readonly variant?: string
}

/** Resolve the effective default text for a section given optional active variant keys. */
export function pickSectionDefaultText(
  section: PromptSectionDef,
  variants?: Readonly<Record<string, string>>,
): { readonly text: string; readonly variant?: string } {
  const variantKey = variants?.[section.id]
  if (variantKey !== undefined && section.variants?.[variantKey] !== undefined) {
    return { text: section.variants[variantKey]!, variant: variantKey }
  }
  return { text: section.defaultText }
}

/**
 * Resolve every section of `turnId` in registry order, applying
 * `stage > pipeline > global > builtin` precedence. Locked sections always
 * resolve to their built-in default text.
 */
export function resolveSections(
  turnId: TurnId,
  options: {
    readonly config?: { readonly prompts?: GlobalPromptsConfig | undefined } | undefined
    readonly pipeline?: { readonly prompt?: PromptSectionsMap | undefined } | undefined
    readonly stage?: { readonly prompt?: PromptSectionsMap | undefined } | undefined
    readonly variants?: Readonly<Record<string, string>> | undefined
  } = {},
): readonly ResolvedPromptSection[] {
  const turn = TURN_REGISTRY[turnId]
  const globalSections = options.config?.prompts?.turns?.[turnId]?.sections
  const pipelineSections = turn.scopeConfigurable ? options.pipeline?.prompt?.sections : undefined
  const stageSections = turn.scopeConfigurable ? options.stage?.prompt?.sections : undefined

  return turn.sections.map((section): ResolvedPromptSection => {
    const picked = pickSectionDefaultText(section, options.variants)
    if (section.locked) {
      return {
        id: section.id,
        label: section.label,
        text: picked.text,
        defaultText: picked.text,
        source: 'builtin',
        locked: true,
        ...(picked.variant === undefined ? {} : { variant: picked.variant }),
      }
    }

    const stageText = stageSections?.[section.id]
    if (stageText !== undefined) {
      return {
        id: section.id,
        label: section.label,
        text: stageText,
        defaultText: picked.text,
        source: 'stage',
        locked: false,
        ...(picked.variant === undefined ? {} : { variant: picked.variant }),
      }
    }

    const pipelineText = pipelineSections?.[section.id]
    if (pipelineText !== undefined) {
      return {
        id: section.id,
        label: section.label,
        text: pipelineText,
        defaultText: picked.text,
        source: 'pipeline',
        locked: false,
        ...(picked.variant === undefined ? {} : { variant: picked.variant }),
      }
    }

    const globalText = globalSections?.[section.id]
    if (globalText !== undefined) {
      return {
        id: section.id,
        label: section.label,
        text: globalText,
        defaultText: picked.text,
        source: 'global',
        locked: false,
        ...(picked.variant === undefined ? {} : { variant: picked.variant }),
      }
    }

    return {
      id: section.id,
      label: section.label,
      text: picked.text,
      defaultText: picked.text,
      source: 'builtin',
      locked: false,
      ...(picked.variant === undefined ? {} : { variant: picked.variant }),
    }
  })
}

function validateSectionText(turnId: string, sectionId: string, text: string): void {
  if (text.length > MAX_PROMPT_SECTION_CHARS) {
    throw new Error(`prompt turn "${turnId}" section "${sectionId}" exceeds max length (${MAX_PROMPT_SECTION_CHARS} chars)`)
  }
  validateTemplateVariables(turnId, sectionId, text)
}

/** Validate global `prompts.turns` overrides. Throws an actionable Error on any violation. */
export function validateGlobalPrompts(prompts: GlobalPromptsConfig | undefined): void {
  if (prompts?.turns === undefined) return
  for (const [turnId, turnConfig] of Object.entries(prompts.turns)) {
    if (turnConfig === undefined) continue
    if (!isTurnId(turnId)) {
      throw new Error(`unknown prompt turn "${turnId}"`)
    }
    const turn = TURN_REGISTRY[turnId]
    const byId = new Map(turn.sections.map(s => [s.id, s]))
    for (const [sectionId, text] of Object.entries(turnConfig.sections ?? {})) {
      const def = byId.get(sectionId)
      if (def === undefined) {
        throw new Error(`prompt turn "${turnId}" has unknown section "${sectionId}"`)
      }
      if (def.locked || LOCKED_SECTION_IDS.has(sectionId)) {
        throw new Error(`prompt section "${sectionId}" is locked and cannot be overridden`)
      }
      validateSectionText(turnId, sectionId, text)
    }
  }
}

/** Validate pipeline-level or stage-level `prompt.sections` overrides. */
export function validateScopePrompt(prompt: PromptSectionsMap | undefined, contextLabel: string): void {
  if (prompt?.sections === undefined) return
  for (const [sectionId, text] of Object.entries(prompt.sections)) {
    if (!SCOPE_CONFIGURABLE_SECTION_IDS.has(sectionId)) {
      throw new Error(`prompt turn "executor" has unknown section "${sectionId}" (in ${contextLabel})`)
    }
    if (LOCKED_SECTION_IDS.has(sectionId)) {
      throw new Error(`prompt section "${sectionId}" is locked and cannot be overridden`)
    }
    validateSectionText('executor', sectionId, text)
  }
}
