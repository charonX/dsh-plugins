/** Sidebar navigation icon for the project-mapping config page. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render the decorative branch icon at the rail's own size. */
export function MappingsNavIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconBranchOutlineRegular size={size} />
}
