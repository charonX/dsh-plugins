/** The team & orchestration page: overview strip, hot-reload status banner,
    and sub-view switch between Orchestration workbench and Crew roster. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Button, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CrewInjected } from './crew-source.ts'
import type { PipelineInjected } from './pipeline-source.ts'
import type { RouteInjected } from './route-source.ts'
import type { TeamConfigInjected } from './team-config-source.ts'
import { CrewSection } from './CrewSection.tsx'
import { OrchestrationWorkbench } from './OrchestrationWorkbench.tsx'
import css from './TeamPage.module.css'

export type TeamSubView = 'workbench' | 'crew'

/** Narrowed TeamPage props: runtime monitoring (Steward & Evals) lives on MonitorPage. */
export type TeamPageProps = PropsRuntime<'main'>
  & InjectFace<CrewInjected & PipelineInjected & RouteInjected & TeamConfigInjected>
  & PropsLocale<'dshManager'>

/** Render the team overview strip, YAML hot-reload banner, and sub-view panels. */
export function TeamPage(props: TeamPageProps) {
  const { t } = props
  const [subView, setSubView] = useState<TeamSubView>('workbench')

  return (
    <div className={css.page}>
      <TeamOverviewStrip {...props} />
      <TeamConfigErrorBanner {...props} />
      <div className={css.subViewBar}>
        <SegmentedControl<TeamSubView>
          id="dsh-team-view"
          value={subView}
          onChange={setSubView}
          label={t('team.panel')}
          options={[
            { value: 'workbench', label: t('team.view.workbench') },
            { value: 'crew', label: t('team.view.crew') },
          ]}
        />
      </div>
      <div
        id={`dsh-team-view-${subView}-panel`}
        role="tabpanel"
        aria-labelledby={`dsh-team-view-${subView}`}
      >
        {subView === 'workbench'
          ? (
            <div id="dsh-team-workbench">
              <OrchestrationWorkbench {...props} />
            </div>
          )
          : (
            <section id="dsh-team-crew" className={css.panelSection} aria-label={t('crew.section')}>
              <CrewSection {...props} />
            </section>
          )}
      </div>
    </div>
  )
}

/** Render an explicit error banner when the last `team-config.yaml` hot-reload failed validation. */
function TeamConfigErrorBanner({ useTeamConfig, onTeamConfigReload, t }: TeamPageProps) {
  const snapshot = useTeamConfig(s => s)
  const error = snapshot.configStatus?.lastError
  if (error === undefined || error === '') return null
  return (
    <div className={css.configErrorBanner} role="alert">
      <div className={css.configErrorBody}>
        <strong className={css.configErrorTitle}>{t('team.configError.title')}</strong>
        <p className={css.configErrorDetail}>{error}</p>
        <span className={css.configErrorPath}>{snapshot.configStatus?.filePath}</span>
      </div>
      <Button variant="outline" size="sm" disabled={snapshot.busy === true} onClick={() => { void onTeamConfigReload() }}>
        {t('team.configError.reload')}
      </Button>
    </div>
  )
}

/** Compact summary bar at the top of the team page showing live counts. */
function TeamOverviewStrip({ useCrew, usePipeline, useRoute, t }: TeamPageProps) {
  const crew = useCrew(s => s)
  const pipeline = usePipeline(s => s)
  const route = useRoute(s => s)
  if (crew.status !== 'ready' && pipeline.status !== 'ready' && route.status !== 'ready') {
    return null
  }
  const members = crew.members ?? []
  const pipelines = pipeline.pipelines ?? []
  const rules = route.rules ?? []
  const enabledMembers = members.filter(m => m.enabled).length
  const enabledRules = rules.filter(r => r.enabled).length

  return (
    <div className={css.overviewStrip}>
      <div className={css.overviewStats}>
        <Tag tone="info">{t('team.summary.rules', { enabled: enabledRules, total: rules.length })}</Tag>
        <Tag tone="success">{t('team.summary.pipelines', { count: pipelines.length })}</Tag>
        <Tag tone="neutral">{t('team.summary.crew', { enabled: enabledMembers, total: members.length })}</Tag>
      </div>
    </div>
  )
}
