/** The simplified Team & Flows page: overview strip, YAML hot-reload banner, Flow IR workbench, and Skill catalog. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Button, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FlowInjected } from './flow-source.ts'
import type { TeamConfigInjected } from './team-config-source.ts'
import { FlowWorkbench } from './FlowWorkbench.tsx'
import { SkillCatalogSection } from './SkillCatalogSection.tsx'
import css from './TeamPage.module.css'

export type TeamSubView = 'flows' | 'skills'

export type TeamPageProps = PropsRuntime<'main'>
  & InjectFace<FlowInjected & TeamConfigInjected>
  & PropsLocale<'dshManager'>

/** Render the Flow IR overview strip, YAML hot-reload banner, and Flows / Skills sub-views. */
export function TeamPage(props: TeamPageProps) {
  const { useFlows, onSkillCatalogRefresh, onFlowImportPlaybook, t } = props
  const [subView, setSubView] = useState<TeamSubView>('flows')
  const flowSnapshot = useFlows(s => s)

  const handleCompileSkill = async (skillName: string): Promise<void> => {
    const res = await onFlowImportPlaybook({ kind: 'skill', ref: skillName })
    if (res.ok) setSubView('flows')
  }

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
            { value: 'flows', label: t('team.view.flows') },
            { value: 'skills', label: t('team.view.skills') },
          ]}
        />
      </div>
      <div
        id={`dsh-team-view-${subView}-panel`}
        role="tabpanel"
        aria-labelledby={`dsh-team-view-${subView}`}
      >
        {subView === 'flows'
          ? (
            <div id="dsh-team-workbench">
              <FlowWorkbench {...props} onGoSkills={() => setSubView('skills')} />
            </div>
          )
          : (
            <SkillCatalogSection
              skills={flowSnapshot.skills ?? []}
              busy={flowSnapshot.busy === true}
              onRefresh={onSkillCatalogRefresh}
              onCompileSkill={handleCompileSkill}
              t={t}
            />
          )}
      </div>
    </div>
  )
}

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

function TeamOverviewStrip({ useFlows, t }: TeamPageProps) {
  const flowSnapshot = useFlows(s => s)
  if (flowSnapshot.status !== 'ready') return null
  const flows = flowSnapshot.flows ?? []
  const enabledFlows = flows.filter(f => f.enabled).length
  const skillCount = (flowSnapshot.skills ?? []).length

  return (
    <div className={css.overviewStrip}>
      <div className={css.overviewStats}>
        <Tag tone="info">{t('team.summary.flows', { enabled: enabledFlows, total: flows.length })}</Tag>
        <Tag tone="neutral">{t('team.summary.skills', { count: skillCount })}</Tag>
      </div>
    </div>
  )
}
