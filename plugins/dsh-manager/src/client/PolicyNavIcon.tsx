/** Sidebar navigation icon for the policy page. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render the decorative shield icon at the rail's own size. */
export function PolicyNavIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconShieldOutlineRegular size={size} />
}
