/**
 * Browser half of the skills manager: registers the zh/en dictionaries and the
 * Skills tab on the Plugins page.
 *
 * @module dsh-skills-manager/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { LOCALE_NAMESPACE } from '../shared/api.ts'
import { SkillsPage, type Translate } from './SkillsPage.tsx'
import { SkillsPanelIcon } from './SkillsPanelIcon.tsx'
import { en, zh, type MessageKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the skills manager surface. */
    'skills-manager': MessageKey
  }
}

export const name = 'skills-manager'
export const inject = ['slots', 'locale']

/** Main-panel id: the sidebar row id and the keyed `main` registration share it. */
const PANEL_ID = LOCALE_NAMESPACE

/**
 * Register the locale dictionaries and the Plugins-page tab.
 * @param ctx - browser-side plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }),
    'skills-manager: dictionaries',
  )
  const bound = ctx.locale.bind(LOCALE_NAMESPACE)
  const t: Translate = (key, params) => bound(key as MessageKey, params)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: LOCALE_NAMESPACE,
  }, SkillsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('panel'),
    locale: LOCALE_NAMESPACE,
  }, SkillsPanelIcon))
}
