/** Decorative occupants for the sidebar navigation entries. */
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconLayersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NotificationsInjected } from './notifications-source.ts'
import css from './NavIcon.module.css'


/**
 * Render the board glyph with the unseen-notification badge; the sidebar
 * owns its accessible navigation label.
 * @param props - the sidebar's icon share and the injected notification feed.
 * @returns decorative board icon with its badge.
 */
export function BoardNavIcon({ size, useNotifications }: PropsRuntime<'sidebar.panellist'> & InjectFace<NotificationsInjected>) {
  const snapshot = useNotifications(current => current)
  const unseen = snapshot.unseenCount ?? 0
  return (
    <span className={css.badgeHost}>
      <IconLayersOutlineRegular size={size} />
      {unseen > 0 ? <span className={css.badge} aria-hidden="true">{unseen > 9 ? '9+' : unseen}</span> : null}
    </span>
  )
}
