/**
 * Sidebar glyph for the skills panel.
 *
 * @module dsh-skills-manager/client/SkillsPanelIcon
 */

import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the skills glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and selection state.
 * @returns the icon element.
 */
export function SkillsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.75 7.5h6.5M6.75 10.25h6.5M6.75 13h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M12.9 12.1l.55 1.4 1.4.55-1.4.55-.55 1.4-.55-1.4-1.4-.55 1.4-.55.55-1.4Z" fill="currentColor" />
    </svg>
  )
}
