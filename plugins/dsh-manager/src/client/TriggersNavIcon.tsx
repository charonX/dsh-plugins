/** Sidebar navigation icon for the triggers browse page. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAlarmClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render the decorative polling-clock icon at the rail's own size. */
export function TriggersNavIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconAlarmClockOutlineRegular size={size} />
}
