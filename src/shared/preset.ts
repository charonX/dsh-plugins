/**
 * Shape of the generated preset catalogue, shared by the build-time generator
 * and the browser half. Values live in `src/data/presets.generated.ts`; nothing
 * here imports runtime code, so both halves can name the same types.
 *
 * @module dsh-model-studio/shared/preset
 */

import type { ThinkingFormat } from '../dialect.ts'

/** One representative model a preset writes beside its route. */
export interface PresetModel {
  /** Exact model id the gateway serves. */
  readonly id: string
  /** Human name shown in the official model list. */
  readonly name: string
  /** Context window in tokens, when the snapshot states one. */
  readonly contextWindow?: number
  /** Output cap in tokens, when the snapshot states one. */
  readonly maxTokens?: number
  /** Accepted input modalities, limited to the adapter's vocabulary. */
  readonly input?: readonly ('text' | 'image')[]
  /**
   * Declared reasoning levels, always starting with `off`. Omitted when the
   * snapshot documents no reasoning control for the model, which is also what
   * keeps the `developer` role switch out of play.
   */
  readonly reasoningEfforts?: Readonly<Record<string, string | null>>
}

/** Route-level endpoint compatibility a preset writes. */
export interface PresetCompat {
  /** Dialect to declare; omitted when auto-detection is already right. */
  readonly thinkingFormat?: ThinkingFormat
  /** Whether the route takes a thinking token budget. */
  readonly supportsThinkingTokenBudget?: boolean
  /** System-prompt role switch; written only when the preset declares reasoning. */
  readonly supportsDeveloperRole?: boolean
}

/** One gateway a preset can configure. */
export interface Preset {
  /** Route id and dictionary key in the provider settings document. */
  readonly id: string
  /** Display name for the provider card. */
  readonly name: string
  /** Wire protocol; presets only cover OpenAI-compatible endpoints. */
  readonly api: 'openai-completions'
  /** Endpoint the route points at. */
  readonly baseURL: string
  /** Credential reference the route reads; no secret is ever written by a preset. */
  readonly apiKeyEnv: string
  /** Upstream documentation, when the snapshot links one. */
  readonly doc?: string
  /** Route-level compatibility derived from the snapshot. */
  readonly compat: PresetCompat
  /** Representative models written with the route. */
  readonly models: readonly PresetModel[]
}

/** Provenance and contents of the generated catalogue. */
export interface PresetCatalog {
  /** Upstream project the data came from. */
  readonly source: string
  /** Upstream license. */
  readonly license: string
  /** Snapshot timestamp, ISO 8601, as reported when the catalogue was generated. */
  readonly snapshot: string
  /** Gateways excluded by the protocol filter, for the UI to explain the gap. */
  readonly skipped: { readonly notOpenAiCompatible: number; readonly unusable: number }
  /** Presets in upstream order. */
  readonly presets: readonly Preset[]
}
