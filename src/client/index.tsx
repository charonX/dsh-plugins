/**
 * Browser half of Autoloop: registers zh/en dictionaries and the Autoloop Kanban Monitor page.
 *
 * @module @charonx/dsh-autoloop/client
 */

import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AutoloopIcon } from './AutoloopIcon.tsx'
import { KanbanPage, type Translate, type WorkspaceItemView } from './KanbanPage.tsx'
import { en, zh, type MessageKey } from './locales.ts'

export const LOCALE_NAMESPACE = 'autoloop'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    autoloop: MessageKey
  }
}

export const name = 'autoloop'
export const inject = ['slots', 'locale', 'workspaces?', 'sessions?']

const PANEL_ID = 'autoloop'

export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }),
    'autoloop: dictionaries',
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
        let clientWorkspaces: WorkspaceItemView[] | undefined
        try {
          const wsList = (ctx as any).workspaces?.list?.getSnapshot?.()?.items
          const sessById = (ctx as any).sessions?.list?.getSnapshot?.()?.byId ?? {}
          if (Array.isArray(wsList) && wsList.length > 0) {
            clientWorkspaces = wsList.map((w: any) => ({
              id: String(w.workspaceId ?? w.id ?? w.path),
              title: w.title || w.path,
              path: w.path,
              sessions: (w.sessionIds ?? []).map((sid: string) => {
                const title = sessById[sid]?.title || sid
                return { id: sid, title }
              }),
            }))
          }
        } catch {
          // ignore
        }
        return <KanbanPage t={t} initialWorkspaces={clientWorkspaces} />
      },
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 25,
        label: () => t('panel'),
        locale: LOCALE_NAMESPACE,
      },
      AutoloopIcon,
    ),
  )
}
