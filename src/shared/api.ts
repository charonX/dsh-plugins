/**
 * Wire contract shared by the Host routes and the browser client.
 *
 * @module dsh-immersive-translate/shared/api
 */

/** Absolute route prefix registered on the Host web server. */
export const ROUTE_PREFIX = '/dsh-immersive-translate'

/** Locale namespace owning every string this plugin renders. */
export const LOCALE_NAMESPACE = 'immersive-translate'

/** Target language used until the reader picks another one. */
export const DEFAULT_TARGET_LANGUAGE = 'zh-CN'

/** Languages offered by the reader-facing selector. */
export const TARGET_LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'] as const

/** One reader-facing preference set; persisted by the plugin, not by the settings service. */
export interface TranslatePrefs {
  /** Language every translation is rendered into. */
  readonly targetLanguage: string
  /** Whether the model follows the Host default instead of the explicit override. */
  readonly followDefaultModel: boolean
  /** Explicit provider route, used only when `followDefaultModel` is false. */
  readonly provider?: string
  /** Explicit provider-owned model id, used only when `followDefaultModel` is false. */
  readonly model?: string
}

/** One selectable model as the settings selector needs it. */
export interface ModelView {
  readonly id: string
  readonly name: string
  /** Reasoning efforts the adapter advertises, least first; empty means it reports none. */
  readonly efforts: readonly string[]
  /** Whether this route advertises an `off` reasoning effort, so translation can skip thinking. */
  readonly canDisableThinking: boolean
}

/** One provider route with at least one advertised model. */
export interface ProviderGroupView {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelView[]
}

/** A provider/model pair. */
export interface SelectionView {
  readonly provider: string
  readonly model: string
}

/** Which input decided the effective selection. */
export type SelectionSource = 'override' | 'session' | 'default'

/** Effective selection and the rule that produced it. */
export interface ResolutionView {
  readonly source: SelectionSource | null
  readonly selection: SelectionView | null
}

/** One text unit to translate; `id` correlates the answer with the request. */
export interface TranslateItem {
  readonly id: string
  readonly text: string
}

/** What the settings page and the floating button read on open. */
export interface EngineState {
  readonly prefs: TranslatePrefs
  readonly catalog: readonly ProviderGroupView[]
  readonly resolution: ResolutionView
  readonly limits: {
    readonly maxItemsPerBatch: number
    readonly maxCharsPerItem: number
  }
}

/** One translate request; `sessionId` selects the Session-level model when the caller has one. */
export interface TranslateRequestBody {
  readonly targetLanguage?: string
  readonly sessionId?: string
  readonly items: readonly TranslateItem[]
}

/** One translate answer, plus the route that produced it. */
export interface TranslateResponseBody {
  readonly results: readonly TranslateItem[]
  readonly selection: SelectionView
  readonly source: SelectionSource
}

/** Failure body every route returns outside the 2xx range. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}
