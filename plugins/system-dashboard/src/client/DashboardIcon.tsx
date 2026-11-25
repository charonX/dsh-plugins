/**
 * Sidebar icon glyph for System Dashboard.
 *
 * @module @charonx/dsh-system-dashboard/client/DashboardIcon
 */

import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export function DashboardIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2.5" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M5.25 11.25h2.1l1.45-3.5 2.1 5.25 1.55-3.25h2.3"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
