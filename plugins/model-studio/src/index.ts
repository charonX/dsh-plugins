/**
 * Plugin entry: the Host half of the model studio.
 *
 * The Host owns the data layer (provider presets, the models.dev snapshot, the
 * probe executor) and the settings documents; the browser half only renders the
 * two official Models-page extension seats. Nothing here patches another
 * service's methods — see docs/SPEC.md for the seams this plugin is allowed to
 * use and the ones it deliberately avoids.
 *
 * @module dsh-model-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

export {
  THINKING_FORMATS, candidateFormats, compatSuggestion, profileOf, reasoningEffortsOf, switchFormatOf,
} from './dialect.ts'
export type { CompatSuggestion, ReasoningOption, ReasoningProfile, ThinkingFormat } from './dialect.ts'

export const name = 'model-studio'
export const inject: string[] = []

/**
 * Register the model studio.
 * @param ctx - plugin context.
 */
export function apply(_ctx: Context): void {
  // M1 adds the preset catalogue and the settings writes; M3 adds the probe
  // executor. Kept empty so the repository starts from a green baseline.
}
