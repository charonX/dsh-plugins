/**
 * Thinking dialect inference: which pi-ai `thinkingFormat` a route probably
 * speaks, ordered so a probe finds the answer in as few requests as possible.
 *
 * The input is the model metadata's `reasoning_options` (models.dev vocabulary):
 * `toggle` means the gateway switches thinking with a bare boolean, `effort`
 * means it takes a named level, and `budget_tokens` means it takes a token
 * budget. That shape narrows the candidate list; it does not identify the exact
 * wire spelling, which only a probe can confirm.
 *
 * @module dsh-model-studio/dialect
 */

/** Every `thinkingFormat` the harness adapter accepts, mirroring `SUPPORTED_THINKING_FORMATS`. */
export const THINKING_FORMATS = [
  'openai',
  'deepseek',
  'openrouter',
  'together',
  'baseten',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
] as const

/** One accepted `thinkingFormat`. */
export type ThinkingFormat = (typeof THINKING_FORMATS)[number]

/** One `reasoning_options` entry as models.dev publishes it. */
export type ReasoningOption =
  | { readonly type: 'toggle' }
  | { readonly type: 'effort'; readonly values?: readonly string[] }
  | { readonly type: 'budget_tokens'; readonly min?: number; readonly max?: number }

/** What one model's metadata says about how its thinking is controlled. */
export interface ReasoningProfile {
  /** Control shapes the model documents; empty means it does not reason. */
  readonly shapes: readonly ('toggle' | 'effort' | 'budget')[]
  /** Named levels the model documents, least to greatest. */
  readonly effortValues: readonly string[]
  /** Documented token budget, when the model takes one. */
  readonly budget?: { readonly min?: number; readonly max?: number }
}

/** A compat block this profile suggests trying first. */
export interface CompatSuggestion {
  /** Format to declare on the route, when the profile narrows to one first choice. */
  readonly thinkingFormat?: ThinkingFormat
  /** Whether the route documents a token budget, so the budget field can be sent. */
  readonly supportsThinkingTokenBudget?: boolean
  /** Documented budget range. */
  readonly budget?: { readonly min?: number; readonly max?: number }
}

/** Shapes whose dialects dispatch a bare on/off switch. */
const TOGGLE_FORMATS: readonly ThinkingFormat[] = [
  'qwen',
  'zai',
  'deepseek',
  'qwen-chat-template',
  'chat-template',
  'string-thinking',
]

/** Shapes whose dialects dispatch a named level. */
const EFFORT_FORMATS: readonly ThinkingFormat[] = [
  'openai',
  'together',
  'openrouter',
  'ant-ling',
  'baseten',
]

/**
 * Read the documented control shapes out of a model's `reasoning_options`.
 * @param options - published options; undefined or empty means the model does not reason.
 * @returns the profile a probe planner consumes.
 */
export function profileOf(options: readonly ReasoningOption[] | undefined): ReasoningProfile {
  const shapes: ('toggle' | 'effort' | 'budget')[] = []
  let effortValues: readonly string[] = []
  let budget: { min?: number; max?: number } | undefined
  for (const option of options ?? []) {
    if (option.type === 'toggle') {
      if (!shapes.includes('toggle')) shapes.push('toggle')
      continue
    }
    if (option.type === 'effort') {
      if (!shapes.includes('effort')) shapes.push('effort')
      if (option.values !== undefined && option.values.length > 0) effortValues = [...option.values]
      continue
    }
    if (!shapes.includes('budget')) shapes.push('budget')
    budget = {
      ...option.min === undefined ? {} : { min: option.min },
      ...option.max === undefined ? {} : { max: option.max },
    }
  }
  return {
    shapes,
    effortValues,
    ...budget === undefined ? {} : { budget },
  }
}

/**
 * Order the formats worth trying for one profile.
 *
 * A documented effort ladder points at effort dialects first; a bare toggle
 * points at switch dialects first. Both shapes present keeps effort first
 * because a gateway that takes a level answers with the level form, while a
 * switch-only gateway rejects an unknown field outright.
 * @param profile - documented control shapes.
 * @returns candidate formats in probe order; empty when the model does not reason.
 */
export function candidateFormats(profile: ReasoningProfile): readonly ThinkingFormat[] {
  if (profile.shapes.length === 0) return []
  const first = profile.shapes.includes('effort') ? EFFORT_FORMATS : TOGGLE_FORMATS
  const second = profile.shapes.includes('effort') ? TOGGLE_FORMATS : EFFORT_FORMATS
  return [...new Set([...first, ...second])]
}

/**
 * First switch-shaped dialect worth declaring for one profile.
 *
 * A profile can document both shapes; only the switch family carries a wire
 * spelling for `off`, so a route that must be able to turn thinking off is
 * configured with one of these even when an effort ladder is documented too.
 * @param profile - documented control shapes.
 * @returns the first switch dialect, or undefined when the model does not reason.
 */
export function switchFormatOf(profile: ReasoningProfile): ThinkingFormat | undefined {
  return candidateFormats(profile).find(format => TOGGLE_FORMATS.includes(format))
}

/**
 * Compat block to try first, before any probe.
 * @param profile - documented control shapes.
 * @returns the recommended route compat; empty when the model does not reason.
 */
export function compatSuggestion(profile: ReasoningProfile): CompatSuggestion {
  const format = candidateFormats(profile)[0]
  return {
    ...format === undefined ? {} : { thinkingFormat: format },
    ...profile.shapes.includes('budget')
      ? {
        supportsThinkingTokenBudget: true,
        ...profile.budget === undefined ? {} : { budget: profile.budget },
      }
      : {},
  }
}

/**
 * Map documented effort values onto a `reasoningEfforts` declaration.
 *
 * `off` always comes first and stays empty: the wire spelling of "off" belongs
 * to the format, not to the level name.
 * @param profile - documented control shapes.
 * @returns declared levels in escalation order, or undefined when nothing is documented.
 */
export function reasoningEffortsOf(profile: ReasoningProfile): Record<string, string | null> | undefined {
  if (!profile.shapes.includes('effort') && !profile.shapes.includes('toggle')) return undefined
  const levels: Record<string, string | null> = { off: null }
  for (const value of profile.effortValues) levels[value] = value
  if (profile.effortValues.length === 0) levels['high'] = 'high'
  return levels
}
