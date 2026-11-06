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

/**
 * Native name of each offered language.
 *
 * Language names are not translated: a reader looking for their own language
 * should recognize it in the selector, and the model prompt needs a name next
 * to the bare tag so a weak route cannot mistake the tag for the source text.
 */
export const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  ru: 'Русский',
}

/**
 * Render a language tag for the selector and for the translation prompt.
 * @param language - BCP 47-ish tag stored in preferences.
 * @returns the native name when known, otherwise the tag itself.
 */
export function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language
}

/**
 * Keys that submit the translate box.
 *
 * `enter` translates on Enter and leaves Shift+Enter for a line break;
 * `mod-enter` requires Ctrl or Command and gives plain Enter back to the box.
 * The choice is per reader and applies to that box only, never to the window.
 */
export const SUBMIT_KEYS = ['enter', 'mod-enter'] as const

/** One accepted submit-key mode. */
export type SubmitKey = typeof SUBMIT_KEYS[number]

/** Submit-key mode used until the reader picks another one. */
export const DEFAULT_SUBMIT_KEY: SubmitKey = 'enter'

/**
 * Accept one submit-key mode, ignoring anything a box cannot honour.
 * @param value - candidate from a preference file, a patch, or a selector.
 * @returns the mode, or undefined when it is not one of {@link SUBMIT_KEYS}.
 */
export function submitKeyOf(value: unknown): SubmitKey | undefined {
  return SUBMIT_KEYS.find(mode => mode === value)
}

/** One reader-facing preference set; persisted by the plugin, not by the settings service. */
export interface TranslatePrefs {
  /** Language every translation is rendered into. */
  readonly targetLanguage: string
  /** Whether the model follows the Host default instead of the explicit override. */
  readonly followDefaultModel: boolean
  /** Which key submits the translate box. */
  readonly submitKey: SubmitKey
  /** Explicit provider route, used only when `followDefaultModel` is false. */
  readonly provider?: string
  /** Explicit provider-owned model id, used only when `followDefaultModel` is false. */
  readonly model?: string
}

/** One selectable model as the settings selector needs it. */
export interface ModelView {
  readonly id: string
  readonly name: string
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
  /**
   * Whether the route emitted reasoning for this batch. A route that advertises
   * `off` can still reason, so this is the only proof the setting took effect.
   */
  readonly reasoned: boolean
}

/** Failure body every route returns outside the 2xx range. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}
