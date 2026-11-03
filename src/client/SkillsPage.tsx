/**
 * The Skills main-panel page, reached from the left sidebar.
 *
 * @module dsh-skills-manager/client/SkillsPage
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type {
  AgentTargetView,
  LibrarySnapshot,
  LinkReport,
  LinkEntryView,
  ProjectLinkView,
  SkillView,
  SourceView,
  UpdateCheck,
  WorkspaceOptionView,
} from '../shared/api.ts'
import {
  ApiFailure,
  checkSource,
  installSource,
  linkSource,
  loadAgents,
  loadLibrary,
  loadLinks,
  loadWorkspaces,
  patchSkill,
  patchSource,
  removeSource,
  resyncProject,
  setLinkEnabled,
  unlinkSource,
  updateSource,
  waitForJob,
} from './api.ts'

/** Localized translate function supplied by the slot's `locale` declaration. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Props every section of this tab receives. */
export interface TranslateProps {
  /** Localized `t` function of the `skills-manager` namespace. */
  readonly t: Translate
}

const COLORS = {
  text: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  tertiary: 'var(--dsw-alias-label-tertiary)',
  border: 'var(--dsw-alias-border-l2)',
  borderStrong: 'var(--dsw-alias-border-l4)',
  surface: 'var(--dsw-alias-bg-layer-2)',
  surfaceAlt: 'var(--dsw-alias-bg-layer-1)',
  error: 'var(--dsw-alias-state-error-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  brand: 'var(--dsw-alias-brand-primary)',
  onBrand: 'var(--dsw-alias-label-primary-foreground)',
} as const

const cardStyle = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 'var(--dsw-radius-md)',
  background: COLORS.surface,
  overflow: 'hidden',
} as const

const buttonStyle = {
  border: `1px solid ${COLORS.borderStrong}`,
  borderRadius: 'var(--dsw-radius-sm)',
  background: 'transparent',
  color: COLORS.text,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
} as const

const primaryButtonStyle = {
  ...buttonStyle,
  background: COLORS.brand,
  borderColor: COLORS.brand,
  color: COLORS.onBrand,
} as const

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${COLORS.borderStrong}`,
  borderRadius: 'var(--dsw-radius-sm)',
  background: 'transparent',
  color: COLORS.text,
  padding: '6px 8px',
  fontSize: 13,
  fontFamily: 'inherit',
} as const

const logStyle = {
  margin: 0,
  padding: '8px 12px',
  maxHeight: 220,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  color: COLORS.secondary,
} as const

const STATE_COLORS: Record<string, string> = {
  linked: COLORS.success,
  missing: COLORS.tertiary,
  broken: COLORS.warn,
  conflict: COLORS.error,
  external: COLORS.tertiary,
}

const STATE_KEYS: Record<string, string> = {
  linked: 'linkStateLinked',
  missing: 'linkStateMissing',
  broken: 'linkStateBroken',
  conflict: 'linkStateConflict',
  external: 'linkStateExternal',
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string {
  return error instanceof ApiFailure ? error.code : 'REQUEST_FAILED'
}

/** Skills management surface: sources, install flow, and project links. */
export function SkillsPage({ t }: TranslateProps): ReactElement {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null)
  const [projects, setProjects] = useState<readonly ProjectLinkView[]>([])
  const [agents, setAgents] = useState<readonly AgentTargetView[]>([])
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceOptionView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<{ slug: string; text: string } | null>(null)
  const [expandedSources, setExpandedSources] = useState<readonly string[]>([])
  const [expandedProjects, setExpandedProjects] = useState<readonly string[]>([])
  const [installOpen, setInstallOpen] = useState(false)
  const [linkTarget, setLinkTarget] = useState<{ source: SourceView; skillName?: string } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextLibrary, nextLinks, nextAgents, nextWorkspaces] = await Promise.all([
        loadLibrary(),
        loadLinks(),
        loadAgents(),
        loadWorkspaces(),
      ])
      setSnapshot(nextLibrary)
      setProjects(nextLinks)
      setAgents(nextAgents)
      setWorkspaces(nextWorkspaces)
      setError(null)
    } catch (failure) {
      setError({ code: codeOf(failure), message: messageOf(failure) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = useCallback(async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setNotice(null)
    try {
      await action()
    } catch (failure) {
      setError({ code: codeOf(failure), message: messageOf(failure) })
    } finally {
      setBusy(null)
    }
  }, [])

  const mergeReport = useCallback((report: LinkReport): void => {
    setProjects((current) => {
      const next = current.filter((project) => project.project !== report.project.project)
      return [...next, report.project].sort((left, right) => left.project.localeCompare(right.project))
    })
  }, [])

  const onToggleSource = useCallback(async (source: SourceView): Promise<void> => {
    await runAction(source.slug, async () => {
      setSnapshot(await patchSource(source.slug, { enabled: !source.enabled }))
      setProjects(await loadLinks())
    })
  }, [runAction])

  const onToggleSkill = useCallback(async (source: SourceView, skill: SkillView): Promise<void> => {
    await runAction(`${source.slug}/${skill.skillName}`, async () => {
      await patchSkill(source.slug, skill.skillName, { enabled: !skill.enabled })
      await refresh()
    })
  }, [refresh, runAction])

  const onUpdate = useCallback(async (source: SourceView): Promise<void> => {
    await runAction(source.slug, async () => {
      const jobId = await updateSource(source.slug)
      setLog({ slug: source.slug, text: '' })
      await waitForJob(jobId, (text) => { setLog({ slug: source.slug, text: text ?? '' }) })
      await refresh()
      setLog(null)
      setNotice(t('updateSucceeded', { slug: source.slug }))
    })
  }, [refresh, runAction, t])

  const onRemove = useCallback(async (slug: string): Promise<void> => {
    setPendingRemove(null)
    await runAction(slug, async () => {
      setSnapshot(await removeSource(slug))
      setNotice(t('removedSucceeded', { slug }))
      const links = await loadLinks()
      setProjects(links)
    })
  }, [runAction, t])

  const onCheck = useCallback(async (source: SourceView): Promise<void> => {
    await runAction(`check:${source.slug}`, async () => {
      const check = await checkSource(source.slug)
      await refresh()
      if (check.error !== undefined) {
        setError({ code: check.error.code, message: check.error.message })
      }
    })
  }, [refresh, runAction])

  const onToggleEntry = useCallback(async (
    project: string,
    entry: LinkEntryView,
    enabled: boolean,
  ): Promise<void> => {
    await runAction(`link:${project}`, async () => {
      const report = await setLinkEnabled({
        project,
        source: entry.source,
        skillName: entry.skillName,
        enabled,
      })
      mergeReport(report)
    })
  }, [mergeReport, runAction])

  const onUnlinkEntry = useCallback(async (project: string, entry: LinkEntryView): Promise<void> => {
    await runAction(`link:${project}`, async () => {
      const report = await unlinkSource({ project, source: entry.source, skillName: entry.skillName })
      mergeReport(report)
    })
  }, [mergeReport, runAction])

  const onResyncProject = useCallback(async (project: string): Promise<void> => {
    await runAction(`link:${project}`, async () => {
      const report = await resyncProject(project)
      mergeReport(report)
      setNotice(t('linkResynced', { project }))
    })
  }, [mergeReport, runAction, t])

  const onUnlinkProject = useCallback(async (project: string): Promise<void> => {
    await runAction(`link:${project}`, async () => {
      let latest: LinkReport | null = null
      for (const entry of projects.find((candidate) => candidate.project === project)?.entries ?? []) {
        latest = await unlinkSource({ project, source: entry.source })
      }
      if (latest !== null) mergeReport(latest)
      setNotice(t('linkUnlinked', { project }))
      setProjects(await loadLinks())
    })
  }, [mergeReport, projects, runAction, t])

  const toggleSourceExpanded = useCallback((slug: string): void => {
    setExpandedSources((current) => current.includes(slug)
      ? current.filter((entry) => entry !== slug)
      : [...current, slug])
  }, [])
  const toggleProjectExpanded = useCallback((project: string): void => {
    setExpandedProjects((current) => current.includes(project)
      ? current.filter((entry) => entry !== project)
      : [...current, project])
  }, [])

  const filtered = useFiltered(snapshot, query)
  const counts = useCounts(snapshot)
  const existingSlugs = useMemo(() => (snapshot?.sources ?? []).map((source) => source.slug), [snapshot])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      color: COLORS.text,
      height: '100%',
      overflowY: 'auto',
      boxSizing: 'border-box',
      padding: '24px 28px 48px',
    }}>
      <div style={{ width: '100%', maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{t('title')}</h2>
          <span style={{ color: COLORS.tertiary, fontSize: 12 }}>
            {t('countSources', { count: counts.sources })} · {t('countSkills', { count: counts.skills })}
          </span>
        </div>
        <p style={{ margin: 0, color: COLORS.secondary, fontSize: 13 }}>{t('subtitle')}</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={{ ...inputStyle, width: 240 }}
            value={query}
            placeholder={t('search')}
            aria-label={t('search')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
          <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => { void refresh() }}>
            {t('refresh')}
          </button>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy !== null || (snapshot?.sources.length ?? 0) === 0}
            onClick={() => { setExpandedSources((snapshot?.sources ?? []).map((source) => source.slug)) }}
          >
            {t('expandAll')}
          </button>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy !== null || expandedSources.length === 0}
            onClick={() => { setExpandedSources([]) }}
          >
            {t('collapseAll')}
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy !== null}
            onClick={() => { setInstallOpen(true) }}
          >
            + {t('install')}
          </button>
        </div>
      </header>

      {notice !== null && (
        <div style={{ ...cardStyle, padding: '8px 12px', color: COLORS.success, fontSize: 13 }} role="status">
          {notice}
        </div>
      )}
      {error !== null && (
        <div style={{ ...cardStyle, padding: '8px 12px', color: COLORS.error, fontSize: 13 }} role="alert">
          {t('failed', { message: `${error.message} (${error.code})` })}
        </div>
      )}
      {log !== null && (
        <div style={cardStyle}>
          <div style={{ padding: '8px 12px', fontSize: 12, color: COLORS.secondary, borderBottom: `1px solid ${COLORS.border}` }}>
            {t('installLog')}
          </div>
          <pre style={logStyle}>{log.text === '' ? '…' : log.text}</pre>
        </div>
      )}

      {loading && <p style={{ color: COLORS.secondary, fontSize: 13 }}>{t('loading')}</p>}

      {!loading && snapshot !== null && snapshot.sources.length === 0 && (
        <div style={{ ...cardStyle, padding: 24, textAlign: 'center' }}>
          <p style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>{t('emptyTitle')}</p>
          <p style={{ margin: 0, color: COLORS.secondary, fontSize: 13 }}>{t('emptyHint')}</p>
        </div>
      )}

      {!loading && snapshot !== null && snapshot.sources.length > 0 && filtered.length === 0 && (
        <p style={{ color: COLORS.secondary, fontSize: 13 }}>{t('emptyFiltered')}</p>
      )}

      {filtered.map(({ source, skills }) => (
        <SourceCard
          key={source.slug}
          t={t}
          source={source}
          skills={skills}
          busy={busy}
          expanded={query.trim() !== '' || expandedSources.includes(source.slug)}
          onToggle={() => { toggleSourceExpanded(source.slug) }}
          onUpdate={onUpdate}
          onRemove={(slug) => { setPendingRemove(slug) }}
          onToggleSource={onToggleSource}
          onToggleSkill={onToggleSkill}
          onLink={(value) => { setLinkTarget({ source: value }) }}
          onLinkSkill={(value, skill) => { setLinkTarget({ source: value, skillName: skill.skillName }) }}
          onCheck={onCheck}
        />
      ))}

      {projects.length > 0 && (
        <ProjectsSection
          t={t}
          projects={projects}
          agents={agents}
          busy={busy}
          expanded={expandedProjects}
          onToggleProject={toggleProjectExpanded}
          onExpandAll={() => { setExpandedProjects(projects.map((project) => project.project)) }}
          onCollapseAll={() => { setExpandedProjects([]) }}
          onResync={onResyncProject}
          onUnlink={onUnlinkProject}
          onToggleEntry={onToggleEntry}
          onUnlinkEntry={onUnlinkEntry}
        />
      )}

      {installOpen && (
        <InstallDialog
          t={t}
          existingSlugs={existingSlugs}
          onClose={() => { setInstallOpen(false) }}
          onInstalled={(slug) => {
            setInstallOpen(false)
            setNotice(t('installedSucceeded', { slug }))
            void refresh()
          }}
        />
      )}

      {linkTarget !== null && (
        <LinkDialog
          t={t}
          source={linkTarget.source}
          agents={agents}
          workspaces={workspaces}
          {...(linkTarget.skillName === undefined ? {} : { skillName: linkTarget.skillName })}
          onClose={() => { setLinkTarget(null) }}
          onLinked={(report, project) => {
            setLinkTarget(null)
            mergeReport(report)
            setNotice(linkTarget.skillName === undefined
              ? t('linkSucceeded', { count: report.counts.linked, project })
              : t('linkOneSucceeded', { skill: linkTarget.skillName, project }))
          }}
        />
      )}

      {pendingRemove !== null && (
        <ConfirmRemove
          t={t}
          slug={pendingRemove}
          onCancel={() => { setPendingRemove(null) }}
          onConfirm={(slug) => { void onRemove(slug) }}
        />
      )}
      </div>
    </div>
  )
}

function useFiltered(snapshot: LibrarySnapshot | null, query: string): { source: SourceView; skills: SkillView[] }[] {
  return useMemo(() => {
    const sources = snapshot?.sources ?? []
    const needle = query.trim().toLowerCase()
    if (needle === '') return sources.map((source) => ({ source, skills: [...source.skills] }))
    const result: { source: SourceView; skills: SkillView[] }[] = []
    for (const source of sources) {
      const skills = source.skills.filter((skill) =>
        [skill.name, skill.skillName, skill.description]
          .some((value) => value !== undefined && value.toLowerCase().includes(needle)))
      const sourceMatches = source.slug.toLowerCase().includes(needle)
      if (skills.length > 0 || sourceMatches) result.push({ source, skills: sourceMatches ? [...source.skills] : skills })
    }
    return result
  }, [snapshot, query])
}

function useCounts(snapshot: LibrarySnapshot | null): { sources: number; skills: number } {
  return useMemo(() => {
    const sources = snapshot?.sources ?? []
    return {
      sources: sources.length,
      skills: sources.reduce((total, source) => total + source.skills.length, 0),
    }
  }, [snapshot])
}

interface SourceCardProps extends TranslateProps {
  readonly source: SourceView
  readonly skills: readonly SkillView[]
  readonly busy: string | null
  readonly expanded: boolean
  onToggle(): void
  onUpdate(source: SourceView): Promise<void>
  onRemove(slug: string): void
  onToggleSource(source: SourceView): Promise<void>
  onToggleSkill(source: SourceView, skill: SkillView): Promise<void>
  onLink(source: SourceView): void
  onLinkSkill(source: SourceView, skill: SkillView): void
  onCheck(source: SourceView): Promise<void>
}

function SourceCard({
  t,
  source,
  skills,
  busy,
  expanded,
  onToggle,
  onUpdate,
  onRemove,
  onToggleSource,
  onToggleSkill,
  onLink,
  onLinkSkill,
  onCheck,
}: SourceCardProps): ReactElement {
  const working = busy === source.slug
  const checking = busy === `check:${source.slug}`
  const update = source.update
  return (
    <section style={cardStyle} aria-label={source.slug}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '10px 12px',
          cursor: 'pointer',
          borderBottom: skills.length === 0 || !expanded ? undefined : `1px solid ${COLORS.border}`,
        }}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? t('collapseSource') : t('expandSource')}
          title={expanded ? t('collapseSource') : t('expandSource')}
          onClick={(event) => { event.stopPropagation(); onToggle() }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            padding: 0,
            border: 'none',
            borderRadius: 'var(--dsw-radius-xs)',
            background: 'transparent',
            color: COLORS.tertiary,
            cursor: 'pointer',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 120ms ease',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <strong style={{ fontSize: 14 }}>{source.slug}</strong>
        <Badge text={source.sourceType === 'git' ? 'git' : 'local'} />
        {source.version !== undefined && (
          <span style={{ fontSize: 11, color: COLORS.tertiary }}>{t('version', { version: source.version })}</span>
        )}
        {!source.enabled && <Badge text={t('disabled')} tone="warn" />}
        <UpdateBadge t={t} update={update} />
        {!expanded && (
          <span style={{ fontSize: 11, color: COLORS.tertiary }}>
            {t('countSkills', { count: skills.length })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          onClick={(event) => { event.stopPropagation() }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
        >
        <Switch
          checked={source.enabled}
          label={source.enabled ? t('disableSource') : t('enableSource')}
          disabled={busy !== null}
          onChange={() => { void onToggleSource(source) }}
        />
        <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => { onLink(source) }}>
          {t('link')}
        </button>
        {source.sourceType === 'git' && (
          <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => { void onCheck(source) }}>
            {checking ? t('checking') : t('checkUpdates')}
          </button>
        )}
        {source.sourceType === 'git' && (
          <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => { void onUpdate(source) }}>
            {working ? t('updating') : t('update')}
          </button>
        )}
        <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => { onRemove(source.slug) }}>
          {t('remove')}
        </button>
        </span>
      </div>
      {expanded && source.sourceUrl !== undefined && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: COLORS.tertiary, wordBreak: 'break-all' }}>
          {source.sourceUrl}
        </div>
      )}
      {source.problem !== undefined && (
        <div style={{ padding: '6px 12px', fontSize: 12, color: COLORS.warn }}>{source.problem}</div>
      )}
      {expanded && source.note !== undefined && (
        <div style={{ padding: '0 12px 6px', fontSize: 12, color: COLORS.secondary }}>{t('note')}: {source.note}</div>
      )}
      {expanded && (skills.length === 0
        ? <div style={{ padding: '10px 12px', fontSize: 12, color: COLORS.tertiary }}>{t('noSkills')}</div>
        : skills.map((skill) => (
          <SkillRow
            key={skill.skillName}
            t={t}
            source={source}
            skill={skill}
            busy={busy !== null}
            onToggle={() => { void onToggleSkill(source, skill) }}
            onLink={() => { onLinkSkill(source, skill) }}
          />
        )))}
    </section>
  )
}

interface SkillRowProps extends TranslateProps {
  readonly source: SourceView
  readonly skill: SkillView
  readonly busy: boolean
  onToggle(): void
  onLink(): void
}

function SkillRow({ t, source, skill, busy, onToggle, onLink }: SkillRowProps): ReactElement {
  const disabledBySource = !source.enabled
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '10px 12px',
      borderTop: `1px solid ${COLORS.border}`,
      opacity: disabledBySource ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{skill.name ?? skill.skillName}</span>
          <code style={{ fontSize: 11, color: COLORS.tertiary }}>{skill.skillName}</code>
          {!skill.valid && <Badge text={t('invalid')} tone="warn" />}
          {skill.invocation.modelInvocable && !skill.invocation.userInvocable && <Badge text={t('modelOnly')} />}
          {!skill.invocation.modelInvocable && skill.invocation.userInvocable && <Badge text={t('userOnly')} />}
        </div>
        {skill.description !== undefined && (
          <span style={{ fontSize: 12, color: COLORS.secondary }}>{skill.description}</span>
        )}
        {skill.problem !== undefined && (
          <span style={{ fontSize: 12, color: COLORS.warn }}>{skill.problem}</span>
        )}
        <span title={skill.relativePath} style={{ fontSize: 11, color: COLORS.tertiary }}>
          {t('skillPath')}: {skill.relativePath}
        </span>
      </div>
      <button
        type="button"
        style={buttonStyle}
        disabled={busy || disabledBySource}
        onClick={onLink}
      >
        {t('linkSkill')}
      </button>
      <Switch
        checked={skill.enabled}
        label={skill.enabled ? t('disabled') : t('enabled')}
        disabled={busy || disabledBySource}
        onChange={onToggle}
      />
    </div>
  )
}

interface ProjectsSectionProps extends TranslateProps {
  readonly projects: readonly ProjectLinkView[]
  readonly agents: readonly AgentTargetView[]
  readonly busy: string | null
  readonly expanded: readonly string[]
  onToggleProject(project: string): void
  onExpandAll(): void
  onCollapseAll(): void
  onResync(project: string): Promise<void>
  onUnlink(project: string): Promise<void>
  onToggleEntry(project: string, entry: LinkEntryView, enabled: boolean): Promise<void>
  onUnlinkEntry(project: string, entry: LinkEntryView): Promise<void>
}

/** Entries of a project, each row collapsing to one line with its agent names. */
function ProjectsSection({
  t,
  projects,
  agents,
  busy,
  expanded,
  onToggleProject,
  onExpandAll,
  onCollapseAll,
  onResync,
  onUnlink,
  onToggleEntry,
  onUnlinkEntry,
}: ProjectsSectionProps): ReactElement {
  const nameOf = (key: string): string => agents.find((agent) => agent.name === key)?.displayName ?? key
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t('linkedProjects')}</h3>
        <span style={{ flex: 1 }} />
        <button type="button" style={buttonStyle} onClick={onExpandAll}>{t('expandAll')}</button>
        <button
          type="button"
          style={buttonStyle}
          disabled={expanded.length === 0}
          onClick={onCollapseAll}
        >
          {t('collapseAll')}
        </button>
      </div>
      {projects.map((project) => {
        const open = expanded.includes(project.project)
        const working = busy === `link:${project.project}`
        const counts = project.targets.reduce<Record<string, number>>((total, target) => {
          total[target.state] = (total[target.state] ?? 0) + 1
          return total
        }, {})
        return (
          <div key={project.project} style={cardStyle}>
            <div
              onClick={() => { onToggleProject(project.project) }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '10px 12px',
                cursor: 'pointer',
                borderBottom: open && project.exists ? `1px solid ${COLORS.border}` : undefined,
              }}
            >
              <button
                type="button"
                aria-expanded={open}
                aria-label={open ? t('collapseProject') : t('expandProject')}
                onClick={(event) => { event.stopPropagation(); onToggleProject(project.project) }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 20,
                  height: 20,
                  padding: 0,
                  border: 'none',
                  borderRadius: 'var(--dsw-radius-xs)',
                  background: 'transparent',
                  color: COLORS.tertiary,
                  cursor: 'pointer',
                  transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 120ms ease',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <code
                title={project.project}
                style={{
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '42%',
                }}
              >
                {project.project}
              </code>
              {!project.exists && <Badge text={t('projectMissing')} tone="warn" />}
              <span style={{ fontSize: 11, color: COLORS.tertiary }}>
                {project.agents.map(nameOf).join(' · ')}
              </span>
              {!open && (
                <span style={{ fontSize: 11, color: COLORS.tertiary }}>
                  {t('countSkills', { count: project.entries.length })}
                </span>
              )}
              <span style={{ flex: 1 }} />
              {Object.entries(counts).map(([state, count]) => (
                <span key={state} style={{ fontSize: 11, color: STATE_COLORS[state] ?? COLORS.tertiary }}>
                  {t(STATE_KEYS[state] ?? state)} {count}
                </span>
              ))}
              <span
                onClick={(event) => { event.stopPropagation() }}
                style={{ display: 'inline-flex', gap: 8 }}
              >
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy !== null || !project.exists}
                  onClick={() => { void onResync(project.project) }}
                >
                  {working ? t('loading') : t('resync')}
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy !== null || !project.exists}
                  onClick={() => { void onUnlink(project.project) }}
                >
                  {t('unlinkAll')}
                </button>
              </span>
            </div>
            {open && project.exists && (
              <div style={{ padding: '6px 12px 10px' }}>
                {project.entries.map((entry) => {
                  const stale = project.stale.some((candidate) =>
                    candidate.source === entry.source && candidate.skillName === entry.skillName)
                  const states = entryStates(project, entry)
                  return (
                    <div
                      key={`${entry.source}/${entry.skillName}`}
                      style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '3px 0' }}
                    >
                      <Switch
                        checked={entry.enabled}
                        label={entry.enabled ? t('disabled') : t('enabled')}
                        disabled={busy !== null}
                        onChange={() => { void onToggleEntry(project.project, entry, !entry.enabled) }}
                      />
                      <code style={{ color: COLORS.secondary }}>{entry.source}/{entry.skillName}</code>
                      {stale
                        ? <span style={{ color: COLORS.warn }}>{t('staleEntry')}</span>
                        : entry.enabled === false
                          ? <Badge text={t('disabled')} tone="warn" />
                          : states.map(({ state, agents: agentKeys }) => (
                            <span key={state} style={{ color: STATE_COLORS[state] ?? COLORS.tertiary }}>
                              {t(STATE_KEYS[state] ?? state)} {agentKeys.map(nameOf).join(' · ')}
                            </span>
                          ))}
                      <span style={{ flex: 1 }} />
                      <button
                        type="button"
                        style={{ ...buttonStyle, padding: '0 6px', fontSize: 10 }}
                        disabled={busy !== null}
                        onClick={() => { void onUnlinkEntry(project.project, entry) }}
                      >
                        {t('unlinkOne')}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}

/** Aggregate one entry's link positions into state → agent names. */
function entryStates(project: ProjectLinkView, entry: LinkEntryView): { state: string; agents: string[] }[] {
  const byState = new Map<string, Set<string>>()
  for (const target of project.targets) {
    if (target.skillName !== entry.skillName) continue
    if (target.source !== undefined && target.source !== entry.source) continue
    const set = byState.get(target.state) ?? new Set<string>()
    for (const agent of target.agents) set.add(agent)
    byState.set(target.state, set)
  }
  return [...byState.entries()].map(([state, agents]) => ({ state, agents: [...agents] }))
}

interface LinkDialogProps extends TranslateProps {
  readonly source: SourceView
  readonly skillName?: string
  readonly agents: readonly AgentTargetView[]
  readonly workspaces: readonly WorkspaceOptionView[]
  onClose(): void
  onLinked(report: LinkReport, project: string): void
}

function LinkDialog({ t, source, skillName, agents, workspaces, onClose, onLinked }: LinkDialogProps): ReactElement {
  const listId = `skills-manager-workspaces-${source.slug}`
  const [project, setProject] = useState('')
  const [selected, setSelected] = useState<readonly string[]>(['dsh'])
  const [agentQuery, setAgentQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visibleAgents = useMemo(() => {
    const needle = agentQuery.trim().toLowerCase()
    if (needle === '') return agents
    return agents.filter((agent) =>
      agent.name.toLowerCase().includes(needle) || agent.displayName.toLowerCase().includes(needle))
  }, [agentQuery, agents])

  const toggleAgent = (key: string): void => {
    setSelected((current) => current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [...current, key])
  }

  const submit = useCallback(async (): Promise<void> => {
    if (project.trim() === '' || selected.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const report = await linkSource({
        project: project.trim(),
        source: source.slug,
        agents: selected,
        ...(skillName === undefined ? {} : { skillName }),
      })
      onLinked(report, report.project.project)
    } catch (failure) {
      setError(`${messageOf(failure)} (${codeOf(failure)})`)
    } finally {
      setBusy(false)
    }
  }, [busy, onLinked, project, selected, skillName, source.slug])

  return (
    <Overlay onClose={busy ? undefined : onClose}>
      <div style={{ ...cardStyle, width: 'min(560px, 92vw)', background: COLORS.surfaceAlt }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${COLORS.border}`, fontWeight: 600 }}>
          {t('linkTitle', { slug: skillName === undefined ? source.slug : `${source.slug}/${skillName}` })}
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: COLORS.secondary }}>
            {t('linkProject')}
            <input
              style={inputStyle}
              value={project}
              disabled={busy}
              autoFocus
              list={workspaces.length === 0 ? undefined : listId}
              placeholder={t('linkProjectHint')}
              onChange={(event) => { setProject(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
            />
            {workspaces.length > 0 && (
              <>
                <datalist id={listId}>
                  {workspaces.map((workspace) => (
                    <option key={workspace.path} value={workspace.path}>{workspace.title}</option>
                  ))}
                </datalist>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
                  {workspaces.slice(0, 6).map((workspace) => (
                    <button
                      key={workspace.path}
                      type="button"
                      disabled={busy}
                      title={workspace.path}
                      style={{ ...buttonStyle, padding: '2px 8px', fontSize: 11 }}
                      onClick={() => { setProject(workspace.path) }}
                    >
                      {workspace.title}
                    </button>
                  ))}
                </span>
              </>
            )}
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: COLORS.secondary }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span>{t('linkAgents')}</span>
              <span style={{ color: COLORS.tertiary }}>{t('agentCount', { count: selected.length })}</span>
              <span style={{ flex: 1 }} />
              <input
                style={{ ...inputStyle, width: 160, padding: '2px 6px' }}
                value={agentQuery}
                placeholder={t('agentsSearch')}
                aria-label={t('agentsSearch')}
                onChange={(event) => { setAgentQuery(event.target.value) }}
              />
            </div>
            <div style={{
              maxHeight: 200,
              overflow: 'auto',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 'var(--dsw-radius-sm)',
              padding: '4px 8px',
            }}>
              {visibleAgents.map((agent) => (
                <label key={agent.name} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '3px 0',
                  fontSize: 12,
                  color: COLORS.text,
                  cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(agent.name)}
                    disabled={busy}
                    onChange={() => { toggleAgent(agent.name) }}
                  />
                  <span>{agent.displayName}</span>
                  <code style={{ fontSize: 10, color: COLORS.tertiary }}>{agent.skillsDir}</code>
                  {agent.universal && <Badge text="universal" />}
                </label>
              ))}
            </div>
            <span style={{ color: COLORS.tertiary }}>{t('linkAgentsHint')}</span>
          </div>
          {error !== null && <div style={{ fontSize: 12, color: COLORS.error }} role="alert">{error}</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${COLORS.border}` }}>
          <button type="button" style={buttonStyle} disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy || project.trim() === '' || selected.length === 0}
            onClick={() => { void submit() }}
          >
            {busy ? t('linking') : t('linkStart')}
          </button>
        </div>
      </div>
    </Overlay>
  )
}

function UpdateBadge({ t, update }: { readonly t: Translate; readonly update: UpdateCheck | undefined }): ReactElement | null {
  if (update === undefined) return null
  const checkedAt = new Date(update.checkedAt)
  const time = Number.isNaN(checkedAt.getTime()) ? update.checkedAt : checkedAt.toLocaleString()
  if (update.error !== undefined) {
    return <span style={{ fontSize: 11, color: COLORS.warn }}>{t('updateError', { message: update.error.message })}</span>
  }
  const behind = update.behind ?? 0
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      {behind > 0
        ? <Badge text={t('updateAvailable', { count: behind })} tone="warn" />
        : <span style={{ color: COLORS.tertiary }}>{t('updateCurrent')}</span>}
      {update.dirty === true && <Badge text={t('updateDirty')} tone="warn" />}
      <span style={{ color: COLORS.tertiary }}>{t('updateChecked', { time })}</span>
    </span>
  )
}

interface SwitchProps {
  readonly checked: boolean
  readonly label: string
  readonly disabled?: boolean
  onChange(): void
}

function Switch({ checked, label, disabled = false, onChange }: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onChange}
      style={{
        position: 'relative',
        width: 34,
        height: 20,
        flex: '0 0 auto',
        padding: 0,
        borderRadius: 999,
        border: 'none',
        background: checked ? COLORS.brand : COLORS.borderStrong,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: checked ? 16 : 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: COLORS.onBrand,
        transition: 'left 120ms ease',
      }} />
    </button>
  )
}

function Badge({ text, tone = 'neutral' }: { readonly text: string; readonly tone?: 'neutral' | 'warn' }): ReactElement {
  return (
    <span style={{
      fontSize: 10,
      lineHeight: '16px',
      padding: '0 6px',
      borderRadius: 999,
      border: `1px solid ${tone === 'warn' ? COLORS.warn : COLORS.border}`,
      color: tone === 'warn' ? COLORS.warn : COLORS.tertiary,
      letterSpacing: 0.4,
    }}>
      {text}
    </span>
  )
}

interface InstallDialogProps extends TranslateProps {
  readonly existingSlugs: readonly string[]
  onClose(): void
  onInstalled(slug: string): void
}

function InstallDialog({ t, existingSlugs, onClose, onInstalled }: InstallDialogProps): ReactElement {
  const [sourceType, setSourceType] = useState<'git' | 'local'>('git')
  const [identifier, setIdentifier] = useState('')
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async (): Promise<void> => {
    if (identifier.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    setLog(null)
    try {
      const jobId = await installSource({
        sourceType,
        identifier: identifier.trim(),
        ...(sourceType === 'local' && force ? { force: true } : {}),
      })
      await waitForJob(jobId, (text) => { setLog(text) })
      const after = await loadLibrary()
      const installed = after.sources.find((source) => !existingSlugs.includes(source.slug))
      onInstalled(installed?.slug ?? identifier.trim())
    } catch (failure) {
      setError(`${messageOf(failure)} (${codeOf(failure)})`)
    } finally {
      setBusy(false)
    }
  }, [busy, existingSlugs, force, identifier, onInstalled, sourceType])

  return (
    <Overlay onClose={busy ? undefined : onClose}>
      <div style={{ ...cardStyle, width: 'min(560px, 92vw)', background: COLORS.surfaceAlt }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${COLORS.border}`, fontWeight: 600 }}>
          {t('installTitle')}
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 14 }}>
            {(['git', 'local'] as const).map((value) => (
              <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="skills-manager-source-type"
                  checked={sourceType === value}
                  disabled={busy}
                  onChange={() => { setSourceType(value) }}
                />
                {value === 'git' ? t('sourceTypeGit') : t('sourceTypeLocal')}
              </label>
            ))}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: COLORS.secondary }}>
            {sourceType === 'git' ? t('identifierGit') : t('identifierLocal')}
            <input
              style={inputStyle}
              value={identifier}
              disabled={busy}
              autoFocus
              placeholder={sourceType === 'git' ? t('identifierGitHint') : t('identifierLocalHint')}
              onChange={(event) => { setIdentifier(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
            />
          </label>
          {sourceType === 'local' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.secondary }}>
              <input type="checkbox" checked={force} disabled={busy} onChange={(event) => { setForce(event.target.checked) }} />
              {t('forceLocal')}
            </label>
          )}
          {error !== null && <div style={{ fontSize: 12, color: COLORS.error }} role="alert">{error}</div>}
          {log !== null && (
            <div style={{ ...cardStyle, maxHeight: 220, overflow: 'auto' }}>
              <pre style={logStyle}>{log === '' ? '…' : log}</pre>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${COLORS.border}` }}>
          <button type="button" style={buttonStyle} disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy || identifier.trim() === ''}
            onClick={() => { void submit() }}
          >
            {busy ? t('installRunning') : t('installStart')}
          </button>
        </div>
      </div>
    </Overlay>
  )
}

interface ConfirmRemoveProps extends TranslateProps {
  readonly slug: string
  onCancel(): void
  onConfirm(slug: string): void
}

function ConfirmRemove({ t, slug, onCancel, onConfirm }: ConfirmRemoveProps): ReactElement {
  return (
    <Overlay onClose={onCancel}>
      <div style={{ ...cardStyle, width: 'min(440px, 92vw)', padding: 16, background: COLORS.surfaceAlt }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>{t('removeTitle')}</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: COLORS.secondary }}>
          {t('removeMessage', { slug })}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={buttonStyle} onClick={onCancel}>{t('cancel')}</button>
          <button
            type="button"
            style={{ ...primaryButtonStyle, background: COLORS.error, borderColor: COLORS.error }}
            onClick={() => { onConfirm(slug) }}
          >
            {t('removeConfirm')}
          </button>
        </div>
      </div>
    </Overlay>
  )
}

function Overlay({ children, onClose }: { readonly children: ReactNode; onClose?: (() => void) | undefined }): ReactElement {
  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-2)',
      }}
      onClick={() => { onClose?.() }}
    >
      <div role="dialog" aria-modal="true" onClick={(event) => { event.stopPropagation() }}>
        {children}
      </div>
    </div>
  )
}
