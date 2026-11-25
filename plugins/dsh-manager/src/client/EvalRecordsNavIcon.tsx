/** Sidebar navigation icon for the eval records page. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render the decorative checklist icon at the rail's own size. */
export function EvalRecordsNavIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconChecklistOutlineRegular size={size} />
}
