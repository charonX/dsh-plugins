/**
 * Browser half of System Dashboard: registers zh/en dictionaries, the left sidebar icon,
 * and the keyed `main` dashboard panel.
 *
 * @module @charonx/dsh-system-dashboard/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { LOCALE_NAMESPACE } from '../shared/types.ts'
import { DashboardIcon } from './DashboardIcon.tsx'
import { DashboardPage, type Translate } from './DashboardPage.tsx'
import { en, zh, type MessageKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'system-dashboard': MessageKey
  }
}

export const name = 'system-dashboard'
export const inject = ['slots', 'locale']

const PANEL_ID = LOCALE_NAMESPACE

export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }),
    'system-dashboard: dictionaries',
  )

  const bound = ctx.locale.bind(LOCALE_NAMESPACE)
  const t: Translate = (key, params) => bound(key as MessageKey, params)

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NAMESPACE,
      },
      () => {
        const handleOpenSession = (sessionId: string) => {
          try {
            const uiWorkspace = (ctx as unknown as {
              uiWorkspace?: { openSession?: (id: string) => void }
              root?: { get?: (key: string) => { openSession?: (id: string) => void } | undefined }
            })
            const target = uiWorkspace.uiWorkspace ?? uiWorkspace.root?.get?.('uiWorkspace')
            if (target && typeof target.openSession === 'function') {
              target.openSession(sessionId)
            }
          } catch {
            // ignore navigation failure
          }
        }
        return <DashboardPage t={t} onOpenSession={handleOpenSession} />
      },
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        label: () => t('panel'),
        locale: LOCALE_NAMESPACE,
      },
      DashboardIcon,
    ),
  )
}
