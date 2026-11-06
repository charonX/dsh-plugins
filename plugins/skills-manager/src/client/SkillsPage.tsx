/**
 * The Skills main-panel page, reached from the left sidebar.
 *
 * @module dsh-skills-manager/client/SkillsPage
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AgentTargetView,
  ImportResponse,
  LibrarySnapshot,
  LinkReport,
  LinkEntryView,
  ProjectLinkView,
  ScanResponse,
  ScanSkillView,
  SkillView,
  SourceView,
  UpdateCheck,
  WorkspaceOptionView,
} from '../shared/api.ts'
import type { MessageKey } from './locales.ts'
import {
  ApiFailure,
  checkSource,
  importSkills,
  installSource,
  linkSource,
  loadScan,
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

/**
 * Localized translate function supplied by the slot's `locale` declaration.
 *
 * This is the host's namespace-addressed translate seat, not a looser
 * `(key: string) => string`: a component that accepted any key would be
 * incompatible with the framework-injected `t` the slot composition passes.
 */
export type Translate = TranslateNS<'skills-manager'>

/** Props every section of this tab receives. */
export interface TranslateProps {
  /** Localized `t` function of the `skills-manager` namespace. */
  readonly t: Translate
}

const COLORS = {
  // Container & Layers
  bgLayer1: 'var(--dsw-alias-bg-layer-1, #f8fafc)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  bgLayer3: 'var(--dsw-alias-bg-layer-3, #f1f5f9)',
  bgMask: 'var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.45))',

  // Legacy surface aliases
  surface: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  surfaceAlt: 'var(--dsw-alias-bg-layer-1, #f8fafc)',
  surfaceElevated: 'var(--dsw-alias-bg-layer-3, #f1f5f9)',

  // Typography
  text: 'var(--dsw-alias-label-primary, #111827)',
  secondary: 'var(--dsw-alias-label-secondary, #4b5563)',
  tertiary: 'var(--dsw-alias-label-tertiary, #9ca3af)',

  // Border hierarchy (l1 -> l4)
  borderSubtle: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.04))',
  border: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
  borderInput: 'var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
  borderStrong: 'var(--dsw-alias-border-l4, rgba(0,0,0,0.18))',

  // Brand & States
  brand: 'var(--dsw-alias-brand-primary, #2563eb)',
  onBrand: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  error: 'var(--dsw-alias-state-error-primary, #ef4444)',
  success: 'var(--dsw-alias-state-success-primary, #10b981)',
  warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',

  // Interactive
  interactiveHover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04))',
  interactiveActive: 'var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.08))',

  // Dedicated widgets
  codeBlock: 'var(--dsw-alias-markdown-code-block, #f1f5f9)',
  switchTrack: 'var(--dsw-alias-bg-module-platform, rgba(0,0,0,0.06))',
  switchThumb: 'var(--dsw-alias-switch-thumb, #ffffff)',
} as const

const cardStyle: React.CSSProperties = {
  border: `0.5px solid ${COLORS.border}`,
  borderRadius: 'var(--dsw-radius-md, 8px)',
  background: COLORS.bgLayer2,
  boxShadow: 'var(--dsw-elevation-panel)',
  overflow: 'hidden',
}

const dialogCardStyle: React.CSSProperties = {
  border: `0.5px solid ${COLORS.borderInput}`,
  borderRadius: 'var(--dsw-radius-lg, 12px)',
  background: COLORS.bgLayer2,
  boxShadow: 'var(--dsw-elevation-overlay, 0 16px 36px rgba(0,0,0,0.22))',
  overflow: 'hidden',
}

const buttonStyle: React.CSSProperties = {
  border: `0.5px solid ${COLORS.borderStrong}`,
  borderRadius: 'var(--dsw-radius-md, 8px)',
  background: COLORS.bgLayer2,
  color: COLORS.text,
  padding: '5px 12px',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
  boxSizing: 'border-box',
  transition: 'background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: COLORS.brand,
  borderColor: COLORS.brand,
  color: COLORS.onBrand,
  fontWeight: 600,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  height: 32,
  border: `0.5px solid ${COLORS.borderStrong}`,
  borderRadius: 'var(--dsw-radius-md, 8px)',
  background: COLORS.bgLayer1,
  color: COLORS.text,
  padding: '0 10px',
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
}

const logStyle: React.CSSProperties = {
  margin: 0,
  padding: '10px 14px',
  maxHeight: 220,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: 11,
  lineHeight: '18px',
  background: COLORS.codeBlock,
  color: COLORS.secondary,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
}

const STATE_COLORS: Record<string, string> = {
  linked: COLORS.success,
  missing: COLORS.tertiary,
  broken: COLORS.warn,
  conflict: COLORS.error,
  external: COLORS.tertiary,
}

const STATE_KEYS: Record<string, MessageKey> = {
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
  const [scanOpen, setScanOpen] = useState(false)
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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        color: COLORS.text,
        background: COLORS.bgLayer1,
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '24px 28px 48px',
        fontFamily: 'var(--dsw-font-family, inherit)',
        // Native DSH scrollbar tokens
        ['--dsh-scrollbar-thumb' as string]: 'var(--dsw-alias-scrollbar-bg-l2)',
        ['--dsh-scrollbar-thumb-hover' as string]: 'var(--dsw-alias-scrollbar-hover-l2)',
      }}
    >
      <style>{`
        .dsh-sm-btn {
          white-space: nowrap !important;
          flex-shrink: 0 !important;
          box-sizing: border-box;
          transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
        }
        .dsh-sm-btn:hover:not(:disabled) {
          background: var(--dsw-alias-interactive-bg-hover) !important;
          border-color: var(--dsw-alias-border-l4) !important;
        }
        .dsh-sm-btn:active:not(:disabled) {
          background: var(--dsw-alias-interactive-bg-active) !important;
        }
        .dsh-sm-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed !important;
        }
        .dsh-sm-btn-primary:hover:not(:disabled) {
          opacity: 0.92;
          filter: brightness(1.05);
        }
        .dsh-sm-btn-primary:active:not(:disabled) {
          opacity: 0.85;
        }
        .dsh-sm-btn-danger {
          background: var(--dsw-alias-state-error-primary) !important;
          border-color: var(--dsw-alias-state-error-primary) !important;
          color: var(--dsw-alias-label-primary-foreground) !important;
        }
        .dsh-sm-btn-danger:hover:not(:disabled) {
          opacity: 0.92;
          filter: brightness(1.05);
        }
        .dsh-sm-input:focus {
          border-color: var(--dsw-alias-brand-primary) !important;
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
        }
        .dsh-sm-input::placeholder {
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-sm-row-header {
          transition: background 0.12s ease;
        }
        .dsh-sm-row-header:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-sm-icon-btn {
          transition: background 0.12s ease, color 0.12s ease;
        }
        .dsh-sm-icon-btn:hover {
          background: var(--dsw-alias-interactive-bg-hover);
          color: var(--dsw-alias-label-primary) !important;
        }
        .dsh-sm-opt-hover {
          transition: background 0.12s ease;
        }
        .dsh-sm-opt-hover:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
      `}</style>
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
            className="dsh-sm-input"
            style={{ ...inputStyle, width: 240 }}
            value={query}
            placeholder={t('search')}
            aria-label={t('search')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
          <button type="button" className="dsh-sm-btn" style={buttonStyle} disabled={busy !== null} onClick={() => { void refresh() }}>
            {t('refresh')}
          </button>
          <button
            type="button"
            className="dsh-sm-btn"
            style={buttonStyle}
            disabled={busy !== null || (snapshot?.sources.length ?? 0) === 0}
            onClick={() => { setExpandedSources((snapshot?.sources ?? []).map((source) => source.slug)) }}
          >
            {t('expandAll')}
          </button>
          <button
            type="button"
            className="dsh-sm-btn"
            style={buttonStyle}
            disabled={busy !== null || expandedSources.length === 0}
            onClick={() => { setExpandedSources([]) }}
          >
            {t('collapseAll')}
          </button>
          <button
            type="button"
            className="dsh-sm-btn"
            style={buttonStyle}
            disabled={busy !== null}
            onClick={() => { setScanOpen(true) }}
          >
            {t('scan')}
          </button>
          <button
            type="button"
            className="dsh-sm-btn dsh-sm-btn-primary"
            style={primaryButtonStyle}
            disabled={busy !== null}
            onClick={() => { setInstallOpen(true) }}
          >
            + {t('install')}
          </button>
        </div>
      </header>

      {notice !== null && (
        <div
          style={{
            ...cardStyle,
            padding: '10px 14px',
            background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, var(--dsw-alias-bg-layer-2))',
            borderColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent)',
            color: COLORS.success,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
          role="status"
        >
          <span>✓</span>
          <span>{notice}</span>
        </div>
      )}
      {error !== null && (
        <div
          style={{
            ...cardStyle,
            padding: '10px 14px',
            background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-layer-2))',
            borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent)',
            color: COLORS.error,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
          role="alert"
        >
          <span>⚠</span>
          <span>{t('failed', { message: `${error.message} (${error.code})` })}</span>
        </div>
      )}
      {log !== null && (
        <div style={cardStyle}>
          <div style={{ padding: '8px 12px', fontSize: 12, color: COLORS.secondary, borderBottom: `1px solid ${COLORS.borderSubtle}` }}>
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

      {scanOpen && (
        <ScanDialog
          t={t}
          onClose={() => { setScanOpen(false) }}
          onImported={() => { void refresh() }}
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
          onClose={() => { setLinkTarget(null); void refresh() }}
          onLinked={(reports) => {
            const projects = reports.map((report) => report.project.project)
            for (const report of reports) mergeReport(report)
            setExpandedProjects((current) => [...new Set([...current, ...projects])])
            const linked = reports.reduce((total, report) => total + report.counts.linked, 0)
            setNotice(linkTarget.skillName === undefined
              ? t('linkSucceededProjects', { count: linked, projects: projects.join(', ') })
              : t('linkOneSucceeded', { skill: linkTarget.skillName, project: projects.join(', ') }))
            setTimeout(() => {
              document.getElementById('skills-manager-projects')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 50)
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
        className="dsh-sm-row-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '10px 14px',
          cursor: 'pointer',
          borderBottom: skills.length === 0 || !expanded ? undefined : `1px solid ${COLORS.borderSubtle}`,
        }}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? t('collapseSource') : t('expandSource')}
          title={expanded ? t('collapseSource') : t('expandSource')}
          onClick={(event) => { event.stopPropagation(); onToggle() }}
          className="dsh-sm-icon-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            padding: 0,
            border: 'none',
            borderRadius: 'var(--dsw-radius-xs, 4px)',
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
        <button type="button" className="dsh-sm-btn" style={buttonStyle} disabled={busy !== null} onClick={() => { onLink(source) }}>
          {t('link')}
        </button>
        {source.sourceType === 'git' && (
          <button type="button" className="dsh-sm-btn" style={buttonStyle} disabled={busy !== null} onClick={() => { void onCheck(source) }}>
            {checking ? t('checking') : t('checkUpdates')}
          </button>
        )}
        {source.sourceType === 'git' && (
          <button type="button" className="dsh-sm-btn" style={buttonStyle} disabled={busy !== null} onClick={() => { void onUpdate(source) }}>
            {working ? t('updating') : t('update')}
          </button>
        )}
        <button type="button" className="dsh-sm-btn" style={buttonStyle} disabled={busy !== null} onClick={() => { onRemove(source.slug) }}>
          {t('remove')}
        </button>
        </span>
      </div>
      {expanded && source.sourceUrl !== undefined && (
        <div style={{ padding: '6px 14px', fontSize: 11, color: COLORS.tertiary, wordBreak: 'break-all' }}>
          {source.sourceUrl}
        </div>
      )}
      {source.problem !== undefined && (
        <div style={{ padding: '6px 14px', fontSize: 12, color: COLORS.warn }}>{source.problem}</div>
      )}
      {expanded && source.note !== undefined && (
        <div style={{ padding: '0 14px 6px', fontSize: 12, color: COLORS.secondary }}>{t('note')}: {source.note}</div>
      )}
      {expanded && (skills.length === 0
        ? <div style={{ padding: '10px 14px', fontSize: 12, color: COLORS.tertiary }}>{t('noSkills')}</div>
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
      padding: '10px 14px',
      borderTop: `1px solid ${COLORS.borderSubtle}`,
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
        className="dsh-sm-btn"
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
    <section id="skills-manager-projects" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t('linkedProjects')}</h3>
        <span style={{ flex: 1 }} />
        <button type="button" className="dsh-sm-btn" style={buttonStyle} onClick={onExpandAll}>{t('expandAll')}</button>
        <button
          type="button"
          className="dsh-sm-btn"
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
              className="dsh-sm-row-header"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '10px 14px',
                cursor: 'pointer',
                borderBottom: open && project.exists ? `1px solid ${COLORS.borderSubtle}` : undefined,
              }}
            >
              <button
                type="button"
                aria-expanded={open}
                aria-label={open ? t('collapseProject') : t('expandProject')}
                onClick={(event) => { event.stopPropagation(); onToggleProject(project.project) }}
                className="dsh-sm-icon-btn"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  padding: 0,
                  border: 'none',
                  borderRadius: 'var(--dsw-radius-xs, 4px)',
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
                  {t(STATE_KEYS[state] ?? (state as MessageKey))} {count}
                </span>
              ))}
              <span
                onClick={(event) => { event.stopPropagation() }}
                style={{ display: 'inline-flex', gap: 8 }}
              >
                <button
                  type="button"
                  className="dsh-sm-btn"
                  style={buttonStyle}
                  disabled={busy !== null || !project.exists}
                  onClick={() => { void onResync(project.project) }}
                >
                  {working ? t('loading') : t('resync')}
                </button>
                <button
                  type="button"
                  className="dsh-sm-btn"
                  style={buttonStyle}
                  disabled={busy !== null || !project.exists}
                  onClick={() => { void onUnlink(project.project) }}
                >
                  {t('unlinkAll')}
                </button>
              </span>
            </div>
            {open && project.exists && (
              <div style={{ padding: '6px 14px 10px' }}>
                {project.entries.map((entry) => {
                  const stale = project.stale.some((candidate) =>
                    candidate.source === entry.source && candidate.skillName === entry.skillName)
                  const states = entryStates(project, entry)
                  return (
                    <div
                      key={`${entry.source}/${entry.skillName}`}
                      style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '4px 0' }}
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
                              {t(STATE_KEYS[state] ?? (state as MessageKey))} {agentKeys.map(nameOf).join(' · ')}
                            </span>
                          ))}
                      <span style={{ flex: 1 }} />
                      <button
                        type="button"
                        className="dsh-sm-btn"
                        style={{ ...buttonStyle, padding: '2px 8px', fontSize: 11 }}
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

interface ScanDialogProps extends TranslateProps {
  onClose(): void
  onImported(): void
}

/** Scan well-known global skill roots and copy selected skills into the library. */
function ScanDialog({ t, onClose, onImported }: ScanDialogProps): ReactElement {
  const [scan, setScan] = useState<ScanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<readonly string[]>([])
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResponse | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setScan(await loadScan())
      setError(null)
    } catch (failure) {
      setError(`${messageOf(failure)} (${codeOf(failure)})`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (skill: ScanSkillView): boolean => needle === ''
      || [skill.name, skill.description, skill.originLabel]
        .some((value) => value !== undefined && value.toLowerCase().includes(needle))
    const byOrigin = new Map<string, ScanSkillView[]>()
    for (const skill of scan?.skills ?? []) {
      if (!matches(skill)) continue
      const list = byOrigin.get(skill.originKey) ?? []
      list.push(skill)
      byOrigin.set(skill.originKey, list)
    }
    return (scan?.roots ?? [])
      .map((root) => ({ root, skills: byOrigin.get(root.key) ?? [] }))
      .filter((group) => needle === '' || group.skills.length > 0 || group.root.label.toLowerCase().includes(needle))
  }, [query, scan])

  const selectable = (skill: ScanSkillView): boolean =>
    skill.status === 'importable' || (skill.status === 'conflict' && overwrite)

  const toggle = (path: string): void => {
    setSelected((current) => current.includes(path)
      ? current.filter((entry) => entry !== path)
      : [...current, path])
  }

  const submit = useCallback(async (): Promise<void> => {
    if (selected.length === 0 || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const response = await importSkills(selected, overwrite)
      setResult(response)
      setSelected([])
      onImported()
      setScan(await loadScan())
    } catch (failure) {
      setError(`${messageOf(failure)} (${codeOf(failure)})`)
    } finally {
      setBusy(false)
    }
  }, [busy, onImported, overwrite, selected])

  const counts = result === null
    ? null
    : {
      imported: result.outcomes.filter((outcome) => outcome.status === 'imported' || outcome.status === 'overwritten').length,
      skipped: result.outcomes.filter((outcome) => outcome.status === 'skipped').length,
      conflict: result.outcomes.filter((outcome) => outcome.status === 'conflict').length,
      failed: result.outcomes.filter((outcome) => outcome.status === 'failed').length,
    }

  return (
    <Overlay onClose={busy ? undefined : onClose}>
      <div style={{
        ...dialogCardStyle,
        width: 'min(720px, 94vw)',
        maxHeight: '86vh',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${COLORS.borderSubtle}` }}>
          <div style={{ fontWeight: 600 }}>{t('scanTitle')}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: COLORS.secondary }}>{t('scanSubtitle')}</div>
        </div>
        <div style={{ padding: '10px 16px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="dsh-sm-input"
            style={{ ...inputStyle, width: 220 }}
            value={query}
            placeholder={t('scanSearch')}
            aria-label={t('scanSearch')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
          <span style={{ fontSize: 11, color: COLORS.tertiary }}>{t('scanSelected', { count: selected.length })}</span>
          <span style={{ flex: 1 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.secondary, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={overwrite}
              disabled={busy}
              style={{ accentColor: COLORS.brand }}
              onChange={(event) => {
                setOverwrite(event.target.checked)
                if (!event.target.checked) {
                  setSelected((current) => current.filter((path) => {
                    const skill = scan?.skills.find((entry) => entry.path === path)
                    return skill === undefined || skill.status !== 'conflict'
                  }))
                }
              }}
            />
            {t('scanOverwrite')}
          </label>
        </div>
        <div style={{ padding: '0 16px 8px', fontSize: 11, color: COLORS.tertiary, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{t('scanOverwriteHint')}</span>
          <span>·</span>
          <span>
            {t('scanRootsSummary', {
              exists: (scan?.roots ?? []).filter((root) => root.exists).length,
              total: (scan?.roots ?? []).length,
            })}
          </span>
          <span>·</span>
          <span>{t('scanRootsHint')}</span>
        </div>
        <div style={{ overflow: 'auto', padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {loading && <p style={{ color: COLORS.secondary, fontSize: 13 }}>{t('scanLoading')}</p>}
          {error !== null && <p style={{ color: COLORS.error, fontSize: 12 }} role="alert">{error}</p>}
          {!loading && groups.length === 0 && (
            <p style={{ color: COLORS.secondary, fontSize: 13 }}>{t('scanEmpty')}</p>
          )}
          {groups.map(({ root, skills: groupSkills }) => (
            <div key={root.key} style={{ marginTop: 6 }}>
              <div style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                padding: '6px 4px',
                borderBottom: `1px solid ${COLORS.borderSubtle}`,
              }}>
                <strong style={{ fontSize: 12 }}>{root.label}</strong>
                <code
                  title={root.path}
                  style={{ fontSize: 10, color: COLORS.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}
                >
                  {root.path}
                </code>
                <span style={{ fontSize: 11, color: COLORS.tertiary }}>
                  {t('countSkills', { count: groupSkills.length })}
                </span>
                {!root.exists && <Badge text={t('scanMissingRoot')} tone="warn" />}
                {root.exists && groupSkills.length === 0 && (
                  <span style={{ fontSize: 11, color: COLORS.tertiary }}>{t('scanGroupEmpty')}</span>
                )}
              </div>
              {groupSkills.map((skill) => {
                const checkboxId = `scan-${skill.path}`
                return (
                  <label
                    key={skill.path}
                    htmlFor={checkboxId}
                    title={skill.path}
                    className="dsh-sm-opt-hover"
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      padding: '6px 6px 6px 12px',
                      borderBottom: `1px solid ${COLORS.borderSubtle}`,
                      borderRadius: 'var(--dsw-radius-xs, 4px)',
                      opacity: selectable(skill) ? 1 : 0.6,
                      cursor: selectable(skill) ? 'pointer' : 'default',
                    }}
                  >
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={selected.includes(skill.path)}
                      disabled={busy || !selectable(skill)}
                      onChange={() => { toggle(skill.path) }}
                      style={{ marginTop: 3, accentColor: COLORS.brand }}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 13 }}>{skill.name}</strong>
                        <code style={{ fontSize: 11, color: COLORS.tertiary }}>{skill.dirName}</code>
                        <ScanStatus t={t} skill={skill} />
                      </span>
                      {skill.description !== undefined && (
                        <span style={{ fontSize: 12, color: COLORS.secondary }}>{skill.description}</span>
                      )}
                      {skill.problem !== undefined && (
                        <span style={{ fontSize: 11, color: COLORS.warn }}>{skill.problem}</span>
                      )}
                      {skill.existing !== undefined && (
                        <span style={{ fontSize: 11, color: COLORS.tertiary }}>
                          {t('scanConflictDetail', { source: `${skill.existing.source}/${skill.existing.skillName}` })}
                        </span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          ))}
        </div>
        {counts !== null && (
          <div style={{ padding: '8px 16px', fontSize: 12, borderTop: `1px solid ${COLORS.borderSubtle}`, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ color: COLORS.success }}>{t('scanResultImported', { count: counts.imported })}</span>
            <span style={{ color: COLORS.tertiary }}>{t('scanResultSkipped', { count: counts.skipped })}</span>
            {counts.conflict > 0 && <span style={{ color: COLORS.warn }}>{t('scanResultConflicts', { count: counts.conflict })}</span>}
            {counts.failed > 0 && <span style={{ color: COLORS.error }}>{t('scanResultFailed', { count: counts.failed })}</span>}
            {result?.outcomes.filter((outcome) => outcome.status === 'conflict' || outcome.status === 'failed')
              .map((outcome) => (
                <span key={outcome.path} style={{ color: COLORS.warn, width: '100%' }}>
                  {outcome.name}: {outcome.message ?? outcome.code}
                </span>
              ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: `1px solid ${COLORS.borderSubtle}` }}>
          <button type="button" className="dsh-sm-btn" style={buttonStyle} disabled={busy} onClick={onClose}>
            {counts === null ? t('cancel') : t('scanDone')}
          </button>
          <button
            type="button"
            className="dsh-sm-btn dsh-sm-btn-primary"
            style={primaryButtonStyle}
            disabled={busy || selected.length === 0}
            onClick={() => { void submit() }}
          >
            {busy ? t('scanImporting') : t('scanImport')}
          </button>
        </div>
      </div>
    </Overlay>
  )
}

function ScanStatus({ t, skill }: { readonly t: Translate; readonly skill: ScanSkillView }): ReactElement {
  switch (skill.status) {
    case 'importable':
      return <Badge text={t('scanImportable')} />
    case 'imported':
      return <Badge text={t('scanImported')} />
    case 'conflict':
      return <Badge text={t('scanConflict')} tone="warn" />
    case 'invalid':
      return <Badge text={t('scanInvalid')} tone="warn" />
  }
}

interface LinkDialogProps extends TranslateProps {
  readonly source: SourceView
  readonly skillName?: string
  readonly agents: readonly AgentTargetView[]
  readonly workspaces: readonly WorkspaceOptionView[]
  onClose(): void
  onLinked(reports: readonly LinkReport[]): void
}

function LinkDialog({ t, source, skillName, agents, workspaces, onClose, onLinked }: LinkDialogProps): ReactElement {
  const [projects, setProjects] = useState<readonly string[]>([])
  const [customPath, setCustomPath] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<readonly string[]>(['dsh'])
  const [agentQuery, setAgentQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!pickerOpen) return
    const handleOutsideClick = (e: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [pickerOpen])

  const visibleAgents = useMemo(() => {
    const needle = agentQuery.trim().toLowerCase()
    if (needle === '') return agents
    return agents.filter((agent) =>
      agent.name.toLowerCase().includes(needle) || agent.displayName.toLowerCase().includes(needle))
  }, [agentQuery, agents])

  const projectLabel = (path: string): string =>
    workspaces.find((workspace) => workspace.path === path)?.title ?? path.split('/').filter(Boolean).pop() ?? path

  const toggleAgent = (key: string): void => {
    setSelected((current) => current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [...current, key])
  }

  const toggleProject = (path: string): void => {
    setProjects((current) => current.includes(path)
      ? current.filter((entry) => entry !== path)
      : [...current, path])
  }

  const addCustomProject = (): void => {
    const path = customPath.trim()
    if (path === '') return
    if (!projects.includes(path)) setProjects((current) => [...current, path])
    setCustomPath('')
  }

  const submit = useCallback(async (): Promise<void> => {
    if (busy) return
    if (projects.length === 0) {
      setError(t('projectRequired'))
      return
    }
    if (selected.length === 0) {
      setError(t('agentsRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const reports: LinkReport[] = []
    const failures: string[] = []
    for (const project of projects) {
      try {
        reports.push(await linkSource({
          project,
          source: source.slug,
          agents: selected,
          ...(skillName === undefined ? {} : { skillName }),
        }))
      } catch (failure) {
        console.warn('[skills-manager] link failed:', project, codeOf(failure), messageOf(failure))
        failures.push(`${project}: ${messageOf(failure)} (${codeOf(failure)})`)
      }
    }
    if (reports.length > 0) onLinked(reports)
    if (failures.length > 0) {
      setError(failures.join('\n'))
      setBusy(false)
      return
    }
    setBusy(false)
    onClose()
  }, [busy, onClose, onLinked, projects, selected, skillName, source.slug, t])

  return (
    <Overlay onClose={busy ? undefined : onClose}>
      <div style={{
        ...dialogCardStyle,
        overflow: 'visible',
        width: 'min(620px, 94vw)',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: `0.5px solid ${COLORS.borderSubtle}`, fontWeight: 600 }}>
          {t('linkTitle', { slug: skillName === undefined ? source.slug : `${source.slug}/${skillName}` })}
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: COLORS.secondary }}>
            {t('linkProject')}
            <div ref={pickerRef} style={{ position: 'relative' }}>
              <div
                role="combobox"
                tabIndex={busy ? -1 : 0}
                aria-expanded={pickerOpen}
                aria-label={t('selectProjects')}
                onClick={() => { if (!busy) setPickerOpen((open) => !open) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    if (!busy) setPickerOpen((open) => !open)
                  }
                }}
                className="dsh-sm-input"
                style={{
                  ...inputStyle,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexWrap: 'wrap',
                  minHeight: 34,
                  height: 'auto',
                  padding: '4px 8px',
                  textAlign: 'left',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  borderColor: pickerOpen ? COLORS.brand : COLORS.borderStrong,
                  boxShadow: pickerOpen ? '0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent)' : 'none',
                }}
              >
                {projects.length === 0 && <span style={{ color: COLORS.tertiary, fontSize: 13, padding: '2px 4px' }}>{t('selectProjects')}</span>}
                {projects.map((path) => (
                  <span
                    key={path}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 8px',
                      borderRadius: 'var(--dsw-radius-sm, 6px)',
                      border: `0.5px solid ${COLORS.borderInput}`,
                      background: COLORS.bgLayer2,
                      fontSize: 12,
                      fontWeight: 500,
                      color: COLORS.text,
                    }}
                  >
                    {projectLabel(path)}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`${t('removeProject')}: ${path}`}
                      onClick={(event) => { event.stopPropagation(); toggleProject(path) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.stopPropagation()
                          toggleProject(path)
                        }
                      }}
                      style={{ cursor: 'pointer', color: COLORS.tertiary, fontSize: 13, lineHeight: 1 }}
                    >
                      ×
                    </span>
                  </span>
                ))}
                <div
                  style={{
                    marginLeft: 'auto',
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--dsw-alias-label-caption, #81858c)',
                    transform: pickerOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform 140ms ease',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>

              {pickerOpen && (
                <div
                  role="listbox"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    left: 0,
                    right: 0,
                    zIndex: 1100,
                    boxSizing: 'border-box',
                    border: `0.5px solid ${COLORS.border}`,
                    borderRadius: 'var(--dsw-radius-lg, 10px)',
                    background: COLORS.bgLayer2,
                    boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,0.18))',
                    maxHeight: 260,
                    overflowY: 'auto',
                    padding: 4,
                  }}
                  onClick={(e) => { e.stopPropagation() }}
                >
                  {workspaces.length === 0 && (
                    <div style={{ padding: '8px 10px', fontSize: 12, color: COLORS.tertiary }}>
                      {t('customProjectPath')}
                    </div>
                  )}
                  {workspaces.map((workspace) => {
                    const isChecked = projects.includes(workspace.path)
                    return (
                      <label
                        key={workspace.path}
                        title={workspace.path}
                        className="dsh-sm-opt-hover"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 10px',
                          minHeight: 32,
                          boxSizing: 'border-box',
                          fontSize: 13,
                          cursor: 'pointer',
                          borderRadius: 'var(--dsw-radius-md, 6px)',
                          background: isChecked ? 'rgba(37, 99, 235, 0.05)' : 'transparent',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={busy}
                          onChange={() => { toggleProject(workspace.path) }}
                          style={{ accentColor: COLORS.brand }}
                        />
                        <span style={{ fontWeight: isChecked ? 600 : 400, color: isChecked ? COLORS.brand : COLORS.text }}>
                          {workspace.title}
                        </span>
                        <code style={{ fontSize: 11, color: COLORS.tertiary, marginLeft: 'auto', fontFamily: 'var(--ds-font-family-code, monospace)' }}>
                          {workspace.path}
                        </code>
                      </label>
                    )
                  })}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    marginTop: 4,
                    borderTop: `0.5px solid ${COLORS.borderSubtle}`,
                  }}>
                    <input
                      className="dsh-sm-input"
                      style={{
                        ...inputStyle,
                        flex: 1,
                        minWidth: 0,
                        width: 'auto',
                        height: 30,
                        padding: '0 10px',
                        fontSize: 12,
                      }}
                      value={customPath}
                      placeholder={t('customProjectPath')}
                      aria-label={t('customProjectPath')}
                      disabled={busy}
                      onChange={(event) => { setCustomPath(event.target.value) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          addCustomProject()
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="dsh-sm-btn"
                      style={{
                        ...buttonStyle,
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                        height: 30,
                        padding: '0 14px',
                        fontSize: 12,
                      }}
                      disabled={busy || customPath.trim() === ''}
                      onClick={addCustomProject}
                    >
                      {t('addProject')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: COLORS.secondary }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span>{t('linkAgents')}</span>
              <span style={{ color: COLORS.tertiary }}>{t('agentCount', { count: selected.length })}</span>
              <span style={{ flex: 1 }} />
              <input
                className="dsh-sm-input"
                style={{ ...inputStyle, width: 160, padding: '3px 8px' }}
                value={agentQuery}
                placeholder={t('agentsSearch')}
                aria-label={t('agentsSearch')}
                onChange={(event) => { setAgentQuery(event.target.value) }}
              />
            </div>
            <div style={{
              maxHeight: 200,
              overflow: 'auto',
              border: `1px solid ${COLORS.borderInput}`,
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              background: COLORS.bgLayer1,
              padding: '4px 6px',
            }}>
              {visibleAgents.map((agent) => (
                <label
                  key={agent.name}
                  className="dsh-sm-opt-hover"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 6px',
                    fontSize: 12,
                    color: COLORS.text,
                    cursor: 'pointer',
                    borderRadius: 'var(--dsw-radius-xs, 4px)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(agent.name)}
                    disabled={busy}
                    onChange={() => { toggleAgent(agent.name) }}
                    style={{ accentColor: COLORS.brand }}
                  />
                  <span>{agent.displayName}</span>
                  <code style={{ fontSize: 10, color: COLORS.tertiary }}>{agent.skillsDir}</code>
                  {agent.universal && <Badge text="universal" />}
                </label>
              ))}
            </div>
            <span style={{ color: COLORS.tertiary }}>{t('linkAgentsHint')}</span>
          </div>
          {error !== null && (
            <div style={{ fontSize: 12, color: COLORS.error, whiteSpace: 'pre-wrap' }} role="alert">{error}</div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: `1px solid ${COLORS.borderSubtle}` }}>
          <button type="button" className="dsh-sm-btn" style={buttonStyle} disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button
            type="button"
            className="dsh-sm-btn dsh-sm-btn-primary"
            style={primaryButtonStyle}
            disabled={busy}
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
        width: 36,
        height: 20,
        flex: '0 0 auto',
        padding: 0,
        borderRadius: 999,
        border: 'none',
        background: checked ? COLORS.brand : COLORS.switchTrack,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background 0.2s ease, opacity 0.15s ease',
        outline: 'none',
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: checked ? 18 : 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: checked ? COLORS.onBrand : COLORS.switchThumb,
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
        transition: 'left 0.2s ease, background 0.2s ease',
      }} />
    </button>
  )
}

function Badge({ text, tone = 'neutral' }: { readonly text: string; readonly tone?: 'neutral' | 'warn' | 'success' | 'brand' }): ReactElement {
  const toneStyles: Record<string, React.CSSProperties> = {
    neutral: {
      background: 'var(--dsw-alias-interactive-bg-hover)',
      border: `1px solid ${COLORS.borderSubtle}`,
      color: COLORS.secondary,
    },
    warn: {
      background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent)',
      color: COLORS.warn,
    },
    success: {
      background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent)',
      color: COLORS.success,
    },
    brand: {
      background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent)',
      color: COLORS.brand,
    },
  }
  const current = toneStyles[tone] ?? toneStyles.neutral
  return (
    <span style={{
      fontSize: 11,
      lineHeight: '18px',
      padding: '0 7px',
      borderRadius: 999,
      letterSpacing: 0.2,
      fontWeight: 500,
      display: 'inline-flex',
      alignItems: 'center',
      ...current,
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
      <div style={{ ...dialogCardStyle, width: 'min(560px, 92vw)' }}>
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${COLORS.borderSubtle}`, fontWeight: 600 }}>
          {t('installTitle')}
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            {(['git', 'local'] as const).map((value) => (
              <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="skills-manager-source-type"
                  checked={sourceType === value}
                  disabled={busy}
                  onChange={() => { setSourceType(value) }}
                  style={{ accentColor: COLORS.brand }}
                />
                {value === 'git' ? t('sourceTypeGit') : t('sourceTypeLocal')}
              </label>
            ))}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: COLORS.secondary }}>
            {sourceType === 'git' ? t('identifierGit') : t('identifierLocal')}
            <input
              className="dsh-sm-input"
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.secondary, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={force}
                disabled={busy}
                onChange={(event) => { setForce(event.target.checked) }}
                style={{ accentColor: COLORS.brand }}
              />
              {t('forceLocal')}
            </label>
          )}
          {error !== null && <div style={{ fontSize: 12, color: COLORS.error }} role="alert">{error}</div>}
          {log !== null && (
            <div style={{ ...cardStyle, maxHeight: 220, overflow: 'auto', background: COLORS.codeBlock }}>
              <pre style={logStyle}>{log === '' ? '…' : log}</pre>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: `1px solid ${COLORS.borderSubtle}` }}>
          <button type="button" className="dsh-sm-btn" style={buttonStyle} disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button
            type="button"
            className="dsh-sm-btn dsh-sm-btn-primary"
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
      <div style={{ ...dialogCardStyle, width: 'min(440px, 92vw)', padding: 18 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>{t('removeTitle')}</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: COLORS.secondary }}>
          {t('removeMessage', { slug })}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="dsh-sm-btn" style={buttonStyle} onClick={onCancel}>{t('cancel')}</button>
          <button
            type="button"
            className="dsh-sm-btn dsh-sm-btn-danger"
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
        background: COLORS.bgMask,
        backdropFilter: 'blur(3px)',
      }}
      onClick={() => { onClose?.() }}
    >
      <div role="dialog" aria-modal="true" onClick={(event) => { event.stopPropagation() }}>
        {children}
      </div>
    </div>
  )
}
