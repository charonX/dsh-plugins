/**
 * Browser half of the plugin: dictionary registration, the frame-wide floating
 * control, and the settings page.
 *
 * @module dsh-immersive-translate/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { FloatingButton, type Translate } from './FloatingButton.tsx'
import { SettingsSection } from './SettingsSection.tsx'
import { en, zh, type MessageKey } from './locales.ts'
import { LOCALE_NAMESPACE } from '../shared/api.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the immersive-translate surfaces. */
    'immersive-translate': MessageKey
  }
}

export const name = 'immersive-translate'
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries, the floating control, and the settings section.
 * @param ctx - browser-side plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }),
    'immersive-translate: dictionaries',
  )
  const bound = ctx.locale.bind(LOCALE_NAMESPACE)
  const t: Translate = (key, params) => bound(key as MessageKey, params)

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'immersive-translate.fab',
    locale: LOCALE_NAMESPACE,
    inject: () => ({ t }),
  }, FloatingButton))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'immersive-translate',
    order: 60,
    label: () => t('nav'),
    locale: LOCALE_NAMESPACE,
    inject: () => ({ t }),
  }, SettingsSection))
}
