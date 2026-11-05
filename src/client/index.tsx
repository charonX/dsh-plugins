/**
 * Browser half: the two official Models-page extension seats.
 *
 * The seats are declared by `ui-settings-models` for plugins distributed
 * outside the harness repository:
 *   - `settings.models.provider-card` is keyed by the provider family's
 *     `settingsNs`, and renders inside every card of that family.
 *   - `settings.models.footer` is an ordered area after the provider rows.
 * Nothing is registered yet; M1 fills the footer preset panel and M2 the
 * per-card compat editor.
 *
 * @module dsh-model-studio/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh, type MessageKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the model-studio surfaces. */
    'model-studio': MessageKey
  }
}

export const name = 'model-studio'
export const inject = ['slots', 'locale']

/** Locale namespace owning every string this plugin renders. */
export const LOCALE_NAMESPACE = 'model-studio'

/**
 * Register the dictionaries. The Models-page contributions arrive in M1/M2.
 * @param ctx - browser-side plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }),
    'model-studio: dictionaries',
  )
}
