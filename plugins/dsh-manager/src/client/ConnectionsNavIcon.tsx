/** Sidebar navigation icon for the connections config page. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render the decorative plug icon at the rail's own size. */
export function ConnectionsNavIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconLinkOutlineRegular size={size} />
}
