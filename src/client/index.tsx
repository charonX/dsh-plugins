/**
 * Browser half of the plugin: dictionary registration, the frame-wide floating
 * control, and the settings page.
 *
 * @module dsh-immersive-translate/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { FloatingButton, type Translate } from './FloatingButton.tsx'
import { SelectionTranslate } from './SelectionTranslate.tsx'
import { PageTranslator } from './pageTranslator.ts'
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

/** Interaction id; also the key of the slot that renders its surface. */
const SELECTION_ID = 'immersive-translate.selection'

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

  // One translator per page: closing the panel must not throw the page's
  // translations away, and the plugin's disposer is the only thing that does.
  const page = new PageTranslator()
  ctx.effect(() => () => { page.restore() }, 'immersive-translate: page translation teardown')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'immersive-translate.fab',
    locale: LOCALE_NAMESPACE,
    inject: () => ({ t, page }),
  }, FloatingButton))

  // Conversation selection: the action is admitted by the Host's text-interaction
  // registry and only exists while that service does, so an older runtime that
  // lacks it still loads the plugin.
  ctx.inject(['uiConversation'], (conversationCtx) => {
    conversationCtx.effect(() => conversationCtx.uiConversation.interactions.register({
      id: SELECTION_ID,
      onInteraction(request) {
        if (request.trigger !== 'selection') return
        const text = request.readText()
        if (text === null || text.trim() === '') return
        request.open()
      },
    }), 'immersive-translate: selection interaction')
    conversationCtx.slots.inject('conversation.chat.text-interaction', () => conversationCtx.slots.register({
      name: 'conversation.chat.text-interaction',
      key: SELECTION_ID,
      locale: LOCALE_NAMESPACE,
      inject: () => ({ t }),
    }, SelectionTranslate))
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'immersive-translate',
    order: 60,
    label: () => t('nav'),
    locale: LOCALE_NAMESPACE,
    inject: () => ({ t }),
  }, SettingsSection))
}
