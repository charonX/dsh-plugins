/** The single manager panel: one sidebar entry whose tabs hold every page. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import { BoardPage } from './BoardPage.tsx'
import { MonitorPage } from './MonitorPage.tsx'
import { PolicyPage } from './PolicyPage.tsx'
import { SettingsPage } from './SettingsPage.tsx'
import { TeamPage } from './TeamPage.tsx'
import {
  MANAGER_TABS,
  MANAGER_TAB_LABELS,
  loadManagerTab,
  saveManagerTab,
  type ManagerTab,
} from './manager-tabs.ts'
import type { BoardInjected } from './board-source.ts'
import type { ConnectionsInjected } from './connections-source.ts'
import type { EvalsInjected } from './evals-source.ts'
import type { FlowInjected } from './flow-source.ts'
import type { MappingsInjected } from './mappings-source.ts'
import type { NotificationsInjected } from './notifications-source.ts'
import type { PolicyInjected } from './policy-source.ts'
import type { TeamConfigInjected } from './team-config-source.ts'
import type { StewardInjected } from './steward-source.ts'
import type { TriggersInjected } from './triggers-source.ts'
import type { UiSettingsInjected } from './ui-settings-source.ts'
import type { ImSettingsInjected } from './im-settings-source.ts'
import css from './ManagerPage.module.css'


/** Every source the tabbed panel reads, merged into one slot injection. */
export type ManagerInjected = BoardInjected & NotificationsInjected & ConnectionsInjected
  & MappingsInjected & TriggersInjected & EvalsInjected & StewardInjected
  & UiSettingsInjected & ImSettingsInjected & FlowInjected & TeamConfigInjected & PolicyInjected

/** Manager panel props derived from the framework and the merged sources. */
export type ManagerPageProps = PropsRuntime<'main'> & InjectFace<ManagerInjected> & PropsLocale<'dshManager'>

/** Render the tabbed manager: the heading, the tab list, and the active page. */
export function ManagerPage(props: ManagerPageProps) {
  const { t } = props
  const [tab, setTab] = useState<ManagerTab>(() => loadManagerTab())
  const selectTab = (value: ManagerTab): void => {
    setTab(value)
    saveManagerTab(value)
  }
  const [head, ...tail] = MANAGER_TABS.map((value): SegmentedTab<ManagerTab> => ({
    value,
    label: t(MANAGER_TAB_LABELS[value]),
    id: `dsh-manager-tab-${value}`,
    panelId: `dsh-manager-panel-${value}`,
  }))
  if (head === undefined) throw new Error('the manager tabs must not be empty')
  return (
    <div className={css.page}>
      <header className={css.heading}>
        <h1 className={css.title}>{t('app.title')}</h1>
        <SegmentedTabs
          items={[head, ...tail]}
          value={tab}
          onChange={selectTab}
          label={t('app.title')}
          size="sm"
        />
      </header>
      <div
        className={css.body}
        id={`dsh-manager-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`dsh-manager-tab-${tab}`}
      >
        {tab === 'board' ? <BoardPage {...props} onOpenMonitor={() => selectTab('monitor')} /> : null}
        {tab === 'team' ? <TeamPage {...props} /> : null}
        {tab === 'policy' ? <PolicyPage {...props} /> : null}
        {tab === 'monitor' ? <MonitorPage {...props} /> : null}
        {tab === 'settings' ? <SettingsPage {...props} /> : null}
      </div>
    </div>
  )
}
