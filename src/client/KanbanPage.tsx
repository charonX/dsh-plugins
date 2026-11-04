import React, { useEffect, useState, useCallback } from 'react'
import type { KernelStateSnapshot, Ticket, ModelCatalogView } from '../shared/types.ts'
import type { MessageKey } from './locales.ts'

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

export interface WorkspaceSessionView {
  id: string
  title: string
}

export interface WorkspaceItemView {
  id: string
  title: string
  path: string
  sessions: WorkspaceSessionView[]
}

export interface KanbanPageProps {
  t: Translate
  initialWorkspaces?: WorkspaceItemView[]
  onOpenSession?: (sessionId: string) => void
}

/** Unified DSH design system tokens */
const COLORS = {
  text: 'var(--dsw-alias-label-primary, #111827)',
  secondary: 'var(--dsw-alias-label-secondary, #4b5563)',
  tertiary: 'var(--dsw-alias-label-tertiary, #9ca3af)',
  border: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
  borderSubtle: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.04))',
  borderStrong: 'var(--dsw-alias-border-l4, rgba(0,0,0,0.18))',
  borderInput: 'var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
  surface: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  surfaceAlt: 'var(--dsw-alias-bg-layer-1, #f8fafc)',
  surfaceElevated: 'var(--dsw-alias-bg-layer-3, #f1f5f9)',
  brand: 'var(--dsw-alias-brand-primary, #2563eb)',
  onBrand: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  error: 'var(--dsw-alias-state-error-primary, #ef4444)',
  warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  success: 'var(--dsw-alias-state-success-primary, #10b981)',
  interactiveHover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04))',
} as const

const buttonBaseStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.borderStrong}`,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: COLORS.surface,
  color: COLORS.text,
  padding: '6px 12px',
  fontSize: '12px',
  fontWeight: 500,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  transition: 'all 0.15s ease',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonBaseStyle,
  background: COLORS.brand,
  borderColor: COLORS.brand,
  color: COLORS.onBrand,
  fontWeight: 600,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${COLORS.borderInput}`,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: COLORS.surface,
  color: COLORS.text,
  padding: '7px 10px',
  fontSize: '13px',
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 0.15s ease',
}

/** Deterministic pastel color generator with soft opacity for modern tags */
export function stringToColor(str: string): { bg: string; color: string; border: string } {
  let hash = 0
  const clean = (str || 'default').trim()
  for (let i = 0; i < clean.length; i++) {
    hash = clean.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash % 360)
  return {
    bg: `hsla(${hue}, 70%, 50%, 0.08)`,
    color: `hsl(${hue}, 75%, 32%)`,
    border: `hsla(${hue}, 70%, 50%, 0.22)`,
  }
}

export function getCategoryMeta(cat: string) {
  const text = (cat || '').toLowerCase()
  let icon = '🏷️'
  let label = cat || '常规任务'

  if (/ppt|slide|演示/i.test(text)) {
    icon = '📊'
    if (cat === 'ppt') label = 'PPT设计'
  } else if (/ui|壁纸|图标|设计|样式|视觉|主题/i.test(text)) {
    icon = '🎨'
    if (cat === 'ui_design') label = '视觉设计'
  } else if (/运营|活动|营销|策略/i.test(text)) {
    icon = '📈'
    if (cat === 'operation') label = '运营策略'
  } else if (/运维|部署|环境|服务器|nginx/i.test(text)) {
    icon = '🖥️'
    if (cat === 'ops') label = '运维部署'
  } else if (/数据|统计|报表/i.test(text)) {
    icon = '📉'
    if (cat === 'data') label = '数据分析'
  } else if (/bug|error|故障|缺陷|报错|异常|修复/i.test(text)) {
    icon = '🐛'
    if (cat === 'bugfix') label = '缺陷修复'
  } else if (/feat|开发|需求|功能/i.test(text)) {
    icon = '🚀'
    if (cat === 'feature') label = '功能开发'
  } else if (/重构|治理|解耦|坏味/i.test(text)) {
    icon = '🛠️'
    if (cat === 'refactor') label = '架构治理'
  } else if (/测试|用例|test|spec/i.test(text)) {
    icon = '🧪'
    if (cat === 'testing') label = '测试验证'
  } else if (/文档|doc|手册|方案/i.test(text)) {
    icon = '📝'
    if (cat === 'documentation') label = '文档方案'
  } else if (/审查|review|调研/i.test(text)) {
    icon = '🔍'
    if (cat === 'review') label = '审查调研'
  } else if (cat === 'general') {
    label = '常规任务'
    icon = '⚡'
  }

  const color = stringToColor(label)
  return {
    label,
    icon,
    bg: color.bg,
    color: color.color,
    border: color.border,
  }
}

export function getPriorityMeta(prio?: string) {
  switch (prio) {
    case 'p0':
      return { label: 'P0 紧急', bg: 'rgba(239, 68, 68, 0.1)', color: 'var(--dsw-alias-state-error-primary, #dc2626)', border: 'rgba(239, 68, 68, 0.25)', dot: '🔴' }
    case 'p1':
      return { label: 'P1 高优', bg: 'rgba(245, 158, 11, 0.12)', color: '#c2410c', border: 'rgba(245, 158, 11, 0.3)', dot: '🟠' }
    case 'p2':
      return { label: 'P2 普通', bg: 'rgba(37, 99, 235, 0.1)', color: 'var(--dsw-alias-brand-primary, #2563eb)', border: 'rgba(37, 99, 235, 0.25)', dot: '🔵' }
    case 'p3':
      return { label: 'P3 低优', bg: 'rgba(107, 114, 128, 0.1)', color: 'var(--dsw-alias-label-secondary, #4b5563)', border: 'rgba(107, 114, 128, 0.2)', dot: '⚪' }
    default:
      return { label: 'P2 普通', bg: 'rgba(37, 99, 235, 0.1)', color: 'var(--dsw-alias-brand-primary, #2563eb)', border: 'rgba(37, 99, 235, 0.25)', dot: '🔵' }
  }
}

export function getSourceMeta(src: string) {
  const text = (src || '').toLowerCase()
  let icon = '🌐'
  let label = src || '中台创建'

  if (/feishu|飞书|lark/i.test(text)) {
    icon = '📘'
    label = '飞书'
  } else if (/github/i.test(text)) {
    icon = '🐙'
    label = 'GitHub'
  } else if (/gitlab/i.test(text)) {
    icon = '🦊'
    label = 'GitLab'
  } else if (/sentry/i.test(text)) {
    icon = '🚨'
    label = 'Sentry'
  } else if (/jira/i.test(text)) {
    icon = '🔷'
    label = 'Jira'
  } else if (/tapd/i.test(text)) {
    icon = '📋'
    label = 'TAPD'
  } else if (/dingtalk|钉钉/i.test(text)) {
    icon = '⚡'
    label = '钉钉'
  } else if (/wecom|企业微信|企微/i.test(text)) {
    icon = '💬'
    label = '企业微信'
  } else if (/slack/i.test(text)) {
    icon = '🟣'
    label = 'Slack'
  } else if (/cron|巡检|定时/i.test(text)) {
    icon = '⏰'
    label = '定时巡检'
  } else if (/邮件|mail/i.test(text)) {
    icon = '✉️'
    label = '邮件'
  } else if (src === 'manual-ui' || text === 'manual-ui') {
    label = '中台创建'
    icon = '🖥️'
  }

  const color = stringToColor(label)
  return {
    label,
    icon,
    bg: color.bg,
    color: color.color,
    border: color.border,
  }
}

export function apiPath(path: string): string {
  const prefix = '/api/autoloop'
  const clean = path.startsWith('/') ? path : `/${path}`
  const target = `${prefix}${clean}`
  if (typeof document === 'undefined') return target
  return new URL(target.replace(/^\/+/u, ''), document.baseURI).pathname
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(path), {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Request to ${path} failed (${response.status}): ${text}`)
  }
  return (await response.json()) as T
}

export function KanbanPage({ t, initialWorkspaces, onOpenSession }: KanbanPageProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState<KernelStateSnapshot | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceItemView[]>(initialWorkspaces ?? [])
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState(
    initialWorkspaces?.[0]?.path ?? ''
  )
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogView | null>(null)
  const [threadSelection, setThreadSelection] = useState('')
  const [customThreadId, setCustomThreadId] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedSource, setSelectedSource] = useState('')
  const [selectedPriority, setSelectedPriority] = useState('auto')
  const [selectedSchedule, setSelectedSchedule] = useState('immediate')
  const [selectedModel, setSelectedModel] = useState('default')
  const [selectedPermission, setSelectedPermission] = useState('workspace-write')
  const [runningNowId, setRunningNowId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null)
  const [copyNotice, setCopyNotice] = useState(false)

  const fetchSnapshot = useCallback(async () => {
    try {
      setLoading(true)
      const data = await request<KernelStateSnapshot>('/snapshot')
      setSnapshot(data)
    } catch {
      // Ignore network errors in polling
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchWorkspaces = useCallback(async () => {
    try {
      const data = await request<{ workspaces: WorkspaceItemView[] }>('/workspaces')
      if (Array.isArray(data.workspaces) && data.workspaces.length > 0) {
        setWorkspaces(data.workspaces)
      }
    } catch (err) {
      console.warn('[Autoloop] fetchWorkspaces failed:', err)
    }
  }, [])

  const fetchModels = useCallback(async () => {
    try {
      const data = await request<ModelCatalogView>('/models')
      setModelCatalog(data)
    } catch (err) {
      console.warn('[Autoloop] fetchModels failed:', err)
    }
  }, [])

  useEffect(() => {
    void fetchSnapshot()
    void fetchWorkspaces()
    void fetchModels()
    const timer = setInterval(() => {
      void fetchSnapshot()
    }, 4000)
    return () => clearInterval(timer)
  }, [fetchSnapshot, fetchWorkspaces, fetchModels])

  useEffect(() => {
    if (initialWorkspaces && initialWorkspaces.length > 0 && workspaces.length === 0) {
      setWorkspaces(initialWorkspaces)
    }
  }, [initialWorkspaces, workspaces.length])

  const effectiveWorkspacePath = selectedWorkspacePath && workspaces.some(w => w.path === selectedWorkspacePath)
    ? selectedWorkspacePath
    : workspaces[0]?.path ?? ''

  const handleResolveAttention = async (ticketId: string, answer: string) => {
    try {
      await request('/attention/resolve', {
        method: 'POST',
        body: JSON.stringify({ ticketId, answer }),
      })
      await fetchSnapshot()
    } catch (err) {
      alert(`Error resolving attention: ${String(err)}`)
    }
  }

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!summary.trim() || !effectiveWorkspacePath) return

    let finalThreadId: string | undefined = undefined
    if (threadSelection === '__custom__') {
      finalThreadId = customThreadId.trim() || undefined
    } else if (threadSelection) {
      finalThreadId = threadSelection
    }

    let modelPayload: { provider?: string; model?: string } | undefined = undefined
    if (selectedModel && selectedModel !== 'default') {
      if (selectedModel.includes('/')) {
        const [provider, model] = selectedModel.split('/', 2)
        modelPayload = { provider, model }
      } else {
        modelPayload = { model: selectedModel }
      }
    }

    try {
      await request('/events', {
        method: 'POST',
        body: JSON.stringify({
          source: selectedSource.trim() && selectedSource !== 'auto' ? selectedSource.trim() : undefined,
          summary: summary.trim(),
          threadId: finalThreadId,
          payload: {
            workspacePath: effectiveWorkspacePath,
            category: selectedCategory.trim() && selectedCategory !== 'auto' ? selectedCategory.trim() : undefined,
            priority: selectedPriority !== 'auto' ? selectedPriority : undefined,
            scheduleMode: selectedSchedule,
            model: modelPayload,
            permissionPreset: selectedPermission,
          },
        }),
      })
      setSummary('')
      setThreadSelection('')
      setCustomThreadId('')
      setSelectedCategory('')
      setSelectedSource('')
      setSelectedPriority('auto')
      setSelectedSchedule('immediate')
      setSelectedModel('default')
      setSelectedPermission('workspace-write')
      setDialogOpen(false)
      await fetchSnapshot()
    } catch (err) {
      alert(`Error creating task: ${String(err)}`)
    }
  }

  const handleRunNow = async (ticketId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    try {
      setRunningNowId(ticketId)
      await request('/tickets/run-now', {
        method: 'POST',
        body: JSON.stringify({ ticketId }),
      })
      await fetchSnapshot()
    } catch (err) {
      alert(`Run now error: ${String(err)}`)
    } finally {
      setRunningNowId(null)
    }
  }

  const tickets = snapshot?.tickets ?? []
  const pending = tickets.filter(t => t.status === 'pending')
  const running = tickets.filter(t => t.status === 'running')
  const attention = tickets.filter(t => t.status === 'waiting_attention')
  const done = tickets.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'circuit_broken')

  const currentWorkspace = workspaces.find(w => w.path === selectedWorkspacePath) || workspaces[0]
  const availableSessions = currentWorkspace?.sessions ?? []
  const activeTicket = selectedTicket ? (tickets.find(t => t.id === selectedTicket.id) ?? selectedTicket) : null

  const renderCard = (ticket: Ticket) => {
    const hasResult = Boolean(ticket.assignment?.resultSummary)
    const hasError = Boolean(ticket.assignment?.error)
    const sessionId = ticket.assignment?.sessionId
    const cat = getCategoryMeta(ticket.mandate.intent)
    const prio = getPriorityMeta(ticket.priority)
    const src = getSourceMeta(ticket.source)
    const isNightlyPending = ticket.status === 'pending' && ticket.scheduleMode === 'nightly'

    return (
      <div
        key={ticket.id}
        onClick={() => setSelectedTicket(ticket)}
        style={{
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 'var(--dsw-radius-md, 8px)',
          padding: '12px 14px',
          marginBottom: '10px',
          boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
          cursor: 'pointer',
          transition: 'all 0.18s ease',
          boxSizing: 'border-box',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = COLORS.brand
          e.currentTarget.style.boxShadow = 'var(--dsw-elevation-panel, 0 4px 12px rgba(0,0,0,0.08))'
          e.currentTarget.style.transform = 'translateY(-1px)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = COLORS.border
          e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.03)'
          e.currentTarget.style.transform = 'translateY(0)'
        }}
      >
        {/* Header: Key ID + Source + Priority */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', color: COLORS.tertiary, fontFamily: 'var(--dsw-font-mono, monospace)', fontWeight: 600 }}>
              #{ticket.id}
            </span>
            <span
              style={{
                fontSize: '10px',
                padding: '1px 6px',
                borderRadius: 'var(--dsw-radius-xs, 4px)',
                background: src.bg,
                color: src.color,
                border: `1px solid ${src.border}`,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              {src.icon} {src.label}
            </span>
          </div>
          <span
            style={{
              fontSize: '10px',
              padding: '1px 6px',
              borderRadius: 'var(--dsw-radius-xs, 4px)',
              background: prio.bg,
              color: prio.color,
              border: `1px solid ${prio.border}`,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px',
            }}
          >
            {prio.dot} {prio.label}
          </span>
        </div>

        {/* Title */}
        <div
          style={{
            fontWeight: 600,
            fontSize: '13px',
            marginBottom: '8px',
            color: COLORS.text,
            lineHeight: '1.45',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {ticket.title}
        </div>

        {/* Badges row: Category + Domain Tags + Schedule */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
          <span
            style={{
              fontSize: '11px',
              padding: '1px 6px',
              borderRadius: 'var(--dsw-radius-xs, 4px)',
              background: cat.bg,
              color: cat.color,
              border: `1px solid ${cat.border}`,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '3px',
            }}
          >
            {cat.icon} {ticket.triage?.categoryLabel || cat.label}
          </span>

          {/* Dynamic domain tags extracted by Router */}
          {ticket.tags && ticket.tags.map(tag => {
            const tc = stringToColor(tag)
            return (
              <span
                key={tag}
                style={{
                  fontSize: '11px',
                  padding: '1px 6px',
                  borderRadius: 'var(--dsw-radius-xs, 4px)',
                  background: tc.bg,
                  color: tc.color,
                  border: `1px solid ${tc.border}`,
                  fontWeight: 500,
                }}
              >
                #{tag}
              </span>
            )
          })}

          {ticket.scheduleMode === 'nightly' && (
            <span
              style={{
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: 'var(--dsw-radius-xs, 4px)',
                background: isNightlyPending ? 'rgba(245, 158, 11, 0.12)' : 'rgba(107, 114, 128, 0.08)',
                color: isNightlyPending ? '#b45309' : COLORS.secondary,
                border: isNightlyPending ? '1px solid rgba(245, 158, 11, 0.25)' : `1px solid ${COLORS.borderSubtle}`,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              🌙 {isNightlyPending ? '夜间排队' : '夜间执行'}
            </span>
          )}

          {ticket.scheduleMode === 'scheduled' && (
            <span
              style={{
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: 'var(--dsw-radius-xs, 4px)',
                background: COLORS.surfaceAlt,
                color: COLORS.secondary,
                border: `1px solid ${COLORS.borderSubtle}`,
                fontWeight: 600,
              }}
            >
              🕒 定时
            </span>
          )}

          {ticket.workspace.worktree?.branch && (
            <span style={{ fontSize: '11px', color: COLORS.success, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
              🌿 {ticket.workspace.worktree.branch}
            </span>
          )}

          {ticket.inputs.length > 0 && (
            <span style={{ fontSize: '11px', color: COLORS.brand, fontWeight: 500 }}>
              💬 {ticket.inputs.length} {t('inputsCount')}
            </span>
          )}
        </div>

        {/* Result summary snippet */}
        {hasResult && (
          <div
            style={{
              background: 'rgba(16, 185, 129, 0.08)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              padding: '6px 8px',
              fontSize: '11px',
              color: '#065f46',
              marginBottom: '8px',
              lineHeight: '1.4',
              maxHeight: '44px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <span style={{ fontWeight: 600 }}>📋 {t('resultLabel')}: </span>
            {ticket.assignment!.resultSummary}
          </div>
        )}

        {/* Error snippet */}
        {hasError && (
          <div
            style={{
              background: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              padding: '6px 8px',
              fontSize: '11px',
              color: COLORS.error,
              marginBottom: '8px',
            }}
          >
            ❌ {ticket.assignment!.error}
          </div>
        )}

        {/* Card footer actions */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: '8px',
            paddingTop: '8px',
            borderTop: `1px solid ${COLORS.borderSubtle}`,
          }}
        >
          <div>
            {sessionId && onOpenSession ? (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation()
                  onOpenSession(sessionId)
                }}
                style={{
                  fontSize: '11px',
                  padding: '3px 8px',
                  borderRadius: 'var(--dsw-radius-xs, 4px)',
                  border: `1px solid ${COLORS.brand}`,
                  background: 'rgba(37, 99, 235, 0.08)',
                  color: COLORS.brand,
                  cursor: 'pointer',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {t('openSession')}
              </button>
            ) : (
              <span style={{ fontSize: '11px', color: COLORS.tertiary }}>Hop: {ticket.hopCount}</span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isNightlyPending && (
              <button
                type="button"
                disabled={runningNowId === ticket.id}
                onClick={e => void handleRunNow(ticket.id, e)}
                style={{
                  fontSize: '11px',
                  padding: '3px 8px',
                  borderRadius: 'var(--dsw-radius-xs, 4px)',
                  border: 'none',
                  background: COLORS.brand,
                  color: COLORS.onBrand,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                {runningNowId === ticket.id ? t('runningNow') : t('runNow')}
              </button>
            )}
            <span
              style={{
                fontSize: '11px',
                color: COLORS.brand,
                fontWeight: 600,
              }}
            >
              {t('viewDetails')} →
            </span>
          </div>
        </div>

        {ticket.status === 'waiting_attention' && ticket.attention && (
          <div
            style={{
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.25)',
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              padding: '8px',
              marginTop: '8px',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#b45309', marginBottom: '4px' }}>
              ⚠️ {ticket.attention.question}
            </div>
            {ticket.attention.detail && (
              <div style={{ fontSize: '11px', color: '#78350f', marginBottom: '8px' }}>
                {ticket.attention.detail}
              </div>
            )}
            <div style={{ display: 'flex', gap: '6px' }}>
              {ticket.attention.options.map(opt => (
                <button
                  key={opt.value}
                  onClick={e => {
                    e.stopPropagation()
                    void handleResolveAttention(ticket.id, opt.value)
                  }}
                  style={{
                    padding: '4px 8px',
                    fontSize: '11px',
                    borderRadius: 'var(--dsw-radius-xs, 4px)',
                    border: 'none',
                    background: opt.style === 'danger' ? COLORS.error : COLORS.success,
                    color: COLORS.onBrand,
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderColumn = (title: string, count: number, items: Ticket[], headerIcon: string, headerColor: string) => (
    <div
      style={{
        flex: 1,
        minWidth: '240px',
        background: COLORS.surfaceAlt,
        borderRadius: 'var(--dsw-radius-lg, 10px)',
        border: `1px solid ${COLORS.borderSubtle}`,
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px',
          paddingBottom: '8px',
          borderBottom: `2px solid ${headerColor}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '13px' }}>{headerIcon}</span>
          <span style={{ fontWeight: 600, fontSize: '13px', color: COLORS.text }}>{title}</span>
        </div>
        <span
          style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.borderSubtle}`,
            color: COLORS.secondary,
            padding: '2px 8px',
            borderRadius: '999px',
            fontSize: '11px',
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items.length === 0 ? (
          <div style={{ color: COLORS.tertiary, fontSize: '12px', textAlign: 'center', marginTop: '24px' }}>
            {t('noTickets')}
          </div>
        ) : (
          items.map(renderCard)
        )}
      </div>
    </div>
  )

  return (
    <div
      style={{
        padding: '24px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        background: COLORS.surface,
        color: COLORS.text,
        fontFamily: 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: COLORS.text }}>{t('title')}</h2>
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: COLORS.secondary }}>{t('subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => {
              void fetchSnapshot()
              void fetchWorkspaces()
              void fetchModels()
            }}
            disabled={loading}
            style={buttonBaseStyle}
          >
            🔄 {t('refresh')}
          </button>
          <button
            onClick={() => {
              void fetchWorkspaces()
              void fetchModels()
              setDialogOpen(true)
            }}
            style={primaryButtonStyle}
          >
            {t('createTask')}
          </button>
        </div>
      </div>

      {/* Kanban Board Container */}
      <div style={{ flex: 1, display: 'flex', gap: '14px', overflowX: 'auto', minHeight: 0 }}>
        {renderColumn(t('colPending'), pending.length, pending, '⏳', COLORS.tertiary)}
        {renderColumn(t('colRunning'), running.length, running, '🔄', COLORS.brand)}
        {renderColumn(t('colAttention'), attention.length, attention, '⚠️', COLORS.warn)}
        {renderColumn(t('colDone'), done.length, done, '✅', COLORS.success)}
      </div>

      {/* Create Task Modal */}
      {dialogOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setDialogOpen(false)}
        >
          <div
            style={{
              background: COLORS.surface,
              borderRadius: 'var(--dsw-radius-lg, 12px)',
              border: `1px solid ${COLORS.border}`,
              padding: '24px',
              width: '520px',
              maxWidth: '92%',
              maxHeight: '90vh',
              overflowY: 'auto',
              boxShadow: 'var(--dsw-elevation-overlay, 0 20px 40px rgba(0,0,0,0.25))',
              color: COLORS.text,
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: COLORS.text }}>{t('newTaskTitle')}</h3>
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                style={{ background: 'transparent', border: 'none', color: COLORS.tertiary, fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateTask}>
              {/* Task Summary */}
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                  {t('summaryLabel')}
                </label>
                <textarea
                  value={summary}
                  onChange={e => setSummary(e.target.value)}
                  placeholder={t('summaryPlaceholder')}
                  required
                  rows={3}
                  style={{
                    ...inputStyle,
                    resize: 'vertical',
                  }}
                />
              </div>

              {/* Workspace Selector (Required Dropdown) */}
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                  {t('workspaceLabel')}
                </label>
                <select
                  value={effectiveWorkspacePath}
                  onChange={e => {
                    setSelectedWorkspacePath(e.target.value)
                    setThreadSelection('')
                  }}
                  required
                  style={inputStyle}
                >
                  {workspaces.map(w => (
                    <option key={w.id} value={w.path}>
                      {w.title} ({w.path})
                    </option>
                  ))}
                </select>
              </div>

              {/* Linked Thread / Conversation Selector */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                  {t('threadIdLabel')}
                </label>
                <select
                  value={threadSelection}
                  onChange={e => setThreadSelection(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">{t('newThreadOption')}</option>
                  {availableSessions.length > 0 && (
                    <optgroup label={t('recentConversationsGroup')}>
                      {availableSessions.map(s => (
                        <option key={s.id} value={`dsh:session:${s.id}`}>
                          💬 {s.title} ({s.id.slice(0, 8)})
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <option value="__custom__">{t('customThreadOption')}</option>
                </select>

                {threadSelection === '__custom__' && (
                  <input
                    type="text"
                    value={customThreadId}
                    onChange={e => setCustomThreadId(e.target.value)}
                    placeholder={t('customThreadPlaceholder')}
                    style={{ ...inputStyle, marginTop: '8px' }}
                  />
                )}
              </div>

              {/* Category and Source Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: COLORS.text }}>
                      {t('categoryLabel')}
                    </label>
                    <span style={{ fontSize: '11px', color: COLORS.brand }}>🤖 Router 智能研判</span>
                  </div>
                  <input
                    type="text"
                    value={selectedCategory}
                    onChange={e => setSelectedCategory(e.target.value)}
                    placeholder="留空自动研判，或输入自定义分类..."
                    list="autoloop-categories"
                    style={inputStyle}
                  />
                  <datalist id="autoloop-categories">
                    <option value="缺陷修复" />
                    <option value="PPT设计" />
                    <option value="视觉设计" />
                    <option value="运营策略" />
                    <option value="运维部署" />
                    <option value="功能开发" />
                    <option value="数据分析" />
                    <option value="架构治理" />
                    <option value="测试验证" />
                    <option value="文档方案" />
                  </datalist>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                    {['缺陷修复', 'PPT设计', '视觉设计', '运营策略', '运维部署', '功能开发'].map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setSelectedCategory(c)}
                        style={{
                          fontSize: '10px',
                          padding: '2px 6px',
                          borderRadius: '999px',
                          border: `1px solid ${selectedCategory === c ? COLORS.brand : COLORS.borderSubtle}`,
                          background: selectedCategory === c ? 'rgba(37, 99, 235, 0.12)' : COLORS.surfaceAlt,
                          color: selectedCategory === c ? COLORS.brand : COLORS.secondary,
                          cursor: 'pointer',
                        }}
                      >
                        {c}
                      </button>
                    ))}
                    {selectedCategory && (
                      <button
                        type="button"
                        onClick={() => setSelectedCategory('')}
                        style={{ fontSize: '10px', padding: '1px 4px', border: 'none', background: 'transparent', color: COLORS.error, cursor: 'pointer' }}
                      >
                        ✕ 重置
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: COLORS.text }}>
                      {t('sourceFormLabel')}
                    </label>
                    <span style={{ fontSize: '11px', color: COLORS.brand }}>🤖 Router 自动提取</span>
                  </div>
                  <input
                    type="text"
                    value={selectedSource}
                    onChange={e => setSelectedSource(e.target.value)}
                    placeholder="留空自动识别渠道，或输入自定义来源..."
                    list="autoloop-sources"
                    style={inputStyle}
                  />
                  <datalist id="autoloop-sources">
                    <option value="飞书" />
                    <option value="GitHub" />
                    <option value="Sentry" />
                    <option value="TAPD" />
                    <option value="Jira" />
                    <option value="钉钉" />
                    <option value="企业微信" />
                    <option value="定时巡检" />
                    <option value="中台创建" />
                  </datalist>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                    {['飞书', 'GitHub', 'Sentry', 'TAPD', '钉钉', '巡检'].map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSelectedSource(s)}
                        style={{
                          fontSize: '10px',
                          padding: '2px 6px',
                          borderRadius: '999px',
                          border: `1px solid ${selectedSource === s ? COLORS.brand : COLORS.borderSubtle}`,
                          background: selectedSource === s ? 'rgba(37, 99, 235, 0.12)' : COLORS.surfaceAlt,
                          color: selectedSource === s ? COLORS.brand : COLORS.secondary,
                          cursor: 'pointer',
                        }}
                      >
                        {s}
                      </button>
                    ))}
                    {selectedSource && (
                      <button
                        type="button"
                        onClick={() => setSelectedSource('')}
                        style={{ fontSize: '10px', padding: '1px 4px', border: 'none', background: 'transparent', color: COLORS.error, cursor: 'pointer' }}
                      >
                        ✕ 重置
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Priority and Schedule Mode Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                    {t('priorityLabel')}
                  </label>
                  <select
                    value={selectedPriority}
                    onChange={e => setSelectedPriority(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="auto">{t('priorityAuto')}</option>
                    <option value="p0">{t('prioP0')}</option>
                    <option value="p1">{t('prioP1')}</option>
                    <option value="p2">{t('prioP2')}</option>
                    <option value="p3">{t('prioP3')}</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                    {t('scheduleLabel')}
                  </label>
                  <select
                    value={selectedSchedule}
                    onChange={e => setSelectedSchedule(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="immediate">{t('scheduleImmediate')}</option>
                    <option value="nightly">{t('scheduleNightly')}</option>
                    <option value="scheduled">{t('scheduleScheduled')}</option>
                  </select>
                </div>
              </div>

              {/* Dynamic Model (from DSH) and Permission Settings Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                    {t('modelLabel')}
                  </label>
                  <select
                    value={selectedModel}
                    onChange={e => setSelectedModel(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="default">
                      {t('modelDefault')} {modelCatalog?.defaultSelection?.model ? `(${modelCatalog.defaultSelection.model})` : ''}
                    </option>
                    {modelCatalog?.groups.map(group => (
                      <optgroup key={group.id} label={group.name || group.id}>
                        {group.models.map(m => (
                          <option key={`${group.id}/${m.id}`} value={`${group.id}/${m.id}`}>
                            {m.name || m.id} {m.badge ? `[${m.badge}]` : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                    {t('permissionLabel')}
                  </label>
                  <select
                    value={selectedPermission}
                    onChange={e => setSelectedPermission(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="workspace-write">{t('permWorkspace')}</option>
                    <option value="danger-full-access">{t('permFullAccess')}</option>
                    <option value="read-only">{t('permReadOnly')}</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setDialogOpen(false)}
                  style={buttonBaseStyle}
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  style={primaryButtonStyle}
                >
                  {t('submit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Task Details Modal */}
      {activeTicket && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setSelectedTicket(null)}
        >
          <div
            style={{
              background: COLORS.surface,
              borderRadius: 'var(--dsw-radius-lg, 12px)',
              border: `1px solid ${COLORS.border}`,
              padding: '24px',
              width: '680px',
              maxWidth: '92%',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: 'var(--dsw-elevation-overlay, 0 20px 40px rgba(0,0,0,0.25))',
              color: COLORS.text,
              boxSizing: 'border-box',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                  <span style={{ fontSize: '12px', color: COLORS.tertiary, fontFamily: 'var(--dsw-font-mono, monospace)', fontWeight: 600 }}>
                    #{activeTicket.id}
                  </span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '999px',
                      background: activeTicket.status === 'completed'
                        ? 'rgba(16, 185, 129, 0.12)'
                        : activeTicket.status === 'running'
                        ? 'rgba(37, 99, 235, 0.12)'
                        : activeTicket.status === 'waiting_attention'
                        ? 'rgba(245, 158, 11, 0.12)'
                        : COLORS.surfaceAlt,
                      color: activeTicket.status === 'completed'
                        ? COLORS.success
                        : activeTicket.status === 'running'
                        ? COLORS.brand
                        : activeTicket.status === 'waiting_attention'
                        ? COLORS.warn
                        : COLORS.secondary,
                      border: `1px solid ${COLORS.borderSubtle}`,
                      fontWeight: 600,
                    }}
                  >
                    {activeTicket.status.toUpperCase()}
                  </span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: 'var(--dsw-radius-xs, 4px)',
                      background: getCategoryMeta(activeTicket.mandate.intent).bg,
                      color: getCategoryMeta(activeTicket.mandate.intent).color,
                      border: `1px solid ${getCategoryMeta(activeTicket.mandate.intent).border}`,
                      fontWeight: 600,
                    }}
                  >
                    {getCategoryMeta(activeTicket.mandate.intent).icon} {activeTicket.triage?.categoryLabel || getCategoryMeta(activeTicket.mandate.intent).label}
                  </span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: 'var(--dsw-radius-xs, 4px)',
                      background: getPriorityMeta(activeTicket.priority).bg,
                      color: getPriorityMeta(activeTicket.priority).color,
                      border: `1px solid ${getPriorityMeta(activeTicket.priority).border}`,
                      fontWeight: 700,
                    }}
                  >
                    {getPriorityMeta(activeTicket.priority).dot} {getPriorityMeta(activeTicket.priority).label}
                  </span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: 'var(--dsw-radius-xs, 4px)',
                      background: getSourceMeta(activeTicket.source).bg,
                      color: getSourceMeta(activeTicket.source).color,
                      border: `1px solid ${getSourceMeta(activeTicket.source).border}`,
                      fontWeight: 600,
                    }}
                  >
                    {getSourceMeta(activeTicket.source).icon} {getSourceMeta(activeTicket.source).label}
                  </span>
                  {activeTicket.scheduleMode === 'nightly' && (
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: 'var(--dsw-radius-xs, 4px)',
                        background: 'rgba(245, 158, 11, 0.12)',
                        color: '#b45309',
                        border: '1px solid rgba(245, 158, 11, 0.25)',
                        fontWeight: 600,
                      }}
                    >
                      🌙 夜间低峰
                    </span>
                  )}
                </div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: COLORS.text }}>
                  {activeTicket.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTicket(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '20px',
                  color: COLORS.tertiary,
                  cursor: 'pointer',
                  padding: '4px 8px',
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>

            {/* Scrollable Body */}
            <div style={{ flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
              {/* Nightly pending banner with run now trigger */}
              {activeTicket.status === 'pending' && activeTicket.scheduleMode === 'nightly' && (
                <div
                  style={{
                    background: 'rgba(245, 158, 11, 0.08)',
                    border: '1px solid rgba(245, 158, 11, 0.25)',
                    borderRadius: 'var(--dsw-radius-md, 8px)',
                    padding: '12px 16px',
                    marginBottom: '16px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '12px',
                  }}
                >
                  <div style={{ fontSize: '12px', color: '#b45309', lineHeight: '1.5' }}>
                    {t('nightlyNotice')}
                  </div>
                  <button
                    type="button"
                    disabled={runningNowId === activeTicket.id}
                    onClick={() => void handleRunNow(activeTicket.id)}
                    style={primaryButtonStyle}
                  >
                    {runningNowId === activeTicket.id ? t('runningNow') : t('runNow')}
                  </button>
                </div>
              )}

              {/* Session Jump Banner (if sessionId exists) */}
              {activeTicket.assignment?.sessionId && (
                <div
                  style={{
                    background: 'rgba(37, 99, 235, 0.08)',
                    border: `1px solid ${COLORS.brand}`,
                    borderRadius: 'var(--dsw-radius-md, 8px)',
                    padding: '12px 16px',
                    marginBottom: '16px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '12px',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: COLORS.brand }}>
                      {t('associatedSession')}: <code style={{ fontSize: '12px', background: COLORS.surface, border: `1px solid ${COLORS.borderSubtle}`, padding: '2px 6px', borderRadius: '4px' }}>{activeTicket.assignment.sessionId}</code>
                    </div>
                    <div style={{ fontSize: '11px', color: COLORS.secondary, marginTop: '3px' }}>
                      {t('sessionNotice')}
                    </div>
                  </div>
                  {onOpenSession && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenSession(activeTicket.assignment!.sessionId!)
                        setSelectedTicket(null)
                      }}
                      style={primaryButtonStyle}
                    >
                      {t('openSessionInSidebar')}
                    </button>
                  )}
                </div>
              )}

              {/* Execution Result Box */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 600, color: COLORS.text }}>
                    {t('resultTitle')}
                  </label>
                  {activeTicket.assignment?.resultSummary && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {copyNotice && (
                        <span style={{ fontSize: '11px', color: COLORS.success, fontWeight: 500 }}>
                          ✓ {t('copied')}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          if (activeTicket.assignment?.resultSummary) {
                            await navigator.clipboard.writeText(activeTicket.assignment.resultSummary)
                            setCopyNotice(true)
                            setTimeout(() => setCopyNotice(false), 2000)
                          }
                        }}
                        style={buttonBaseStyle}
                      >
                        {t('copyResult')}
                      </button>
                    </div>
                  )}
                </div>

                <div
                  style={{
                    background: COLORS.surfaceAlt,
                    border: `1px solid ${COLORS.borderSubtle}`,
                    borderRadius: 'var(--dsw-radius-md, 8px)',
                    padding: '12px',
                    minHeight: '80px',
                    maxHeight: '260px',
                    overflowY: 'auto',
                    fontSize: '13px',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: COLORS.text,
                  }}
                >
                  {activeTicket.status === 'running' ? (
                    <div style={{ color: COLORS.brand, display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>⏳</span>
                      {t('runningHint')}
                    </div>
                  ) : activeTicket.assignment?.error ? (
                    <div style={{ color: COLORS.error }}>
                      <strong>Error:</strong> {activeTicket.assignment.error}
                    </div>
                  ) : activeTicket.assignment?.resultSummary ? (
                    activeTicket.assignment.resultSummary
                  ) : (
                    <span style={{ color: COLORS.tertiary }}>{t('noResult')}</span>
                  )}
                </div>
              </div>

              {/* Attention prompt resolution if waiting */}
              {activeTicket.status === 'waiting_attention' && activeTicket.attention && (
                <div
                  style={{
                    background: 'rgba(245, 158, 11, 0.08)',
                    border: '1px solid rgba(245, 158, 11, 0.25)',
                    borderRadius: 'var(--dsw-radius-md, 8px)',
                    padding: '14px',
                    marginBottom: '16px',
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#b45309', marginBottom: '6px' }}>
                    ⚠️ {activeTicket.attention.question}
                  </div>
                  {activeTicket.attention.detail && (
                    <div style={{ fontSize: '12px', color: '#78350f', marginBottom: '10px' }}>
                      {activeTicket.attention.detail}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {activeTicket.attention.options.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={async () => {
                          await handleResolveAttention(activeTicket.id, opt.value)
                        }}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          borderRadius: 'var(--dsw-radius-sm, 6px)',
                          border: 'none',
                          background: opt.style === 'danger' ? COLORS.error : COLORS.success,
                          color: COLORS.onBrand,
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Router Triage Audit Log Block */}
              <div
                style={{
                  background: COLORS.surfaceAlt,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 'var(--dsw-radius-md, 8px)',
                  padding: '14px',
                  marginBottom: '16px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: COLORS.text, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>🧠</span>
                    <span>{t('triageTitle')}</span>
                  </div>
                  {activeTicket.triage?.evaluatedAt && (
                    <span style={{ fontSize: '11px', color: COLORS.tertiary }}>
                      {new Date(activeTicket.triage.evaluatedAt).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                {/* Grid summary of triage decisions */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: '8px',
                    marginBottom: '10px',
                    background: COLORS.surface,
                    border: `1px solid ${COLORS.borderSubtle}`,
                    borderRadius: 'var(--dsw-radius-sm, 6px)',
                    padding: '10px',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <span style={{ color: COLORS.secondary, display: 'block', fontSize: '11px' }}>{t('triageCategory')}</span>
                    <span style={{ fontWeight: 600, color: COLORS.text }}>
                      {getCategoryMeta(activeTicket.mandate.intent).icon} {activeTicket.triage?.categoryLabel || getCategoryMeta(activeTicket.mandate.intent).label}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: COLORS.secondary, display: 'block', fontSize: '11px' }}>{t('triagePriority')}</span>
                    <span style={{ fontWeight: 600, color: COLORS.text }}>
                      {getPriorityMeta(activeTicket.priority).dot} {getPriorityMeta(activeTicket.priority).label}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: COLORS.secondary, display: 'block', fontSize: '11px' }}>{t('triageSchedule')}</span>
                    <span style={{ fontWeight: 600, color: COLORS.text }}>
                      {activeTicket.scheduleMode === 'nightly' ? '🌙 夜间低峰' : activeTicket.scheduleMode === 'scheduled' ? '🕒 定时' : '⚡ 立即执行'}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: COLORS.secondary, display: 'block', fontSize: '11px' }}>{t('triageModel')}</span>
                    <span style={{ fontWeight: 600, color: COLORS.text }}>
                      {activeTicket.mandate.model?.model || '系统默认'}
                    </span>
                  </div>
                </div>

                {/* Domain tags if present */}
                {((activeTicket.triage?.tags && activeTicket.triage.tags.length > 0) || (activeTicket.tags && activeTicket.tags.length > 0)) && (
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: COLORS.secondary, marginBottom: '4px' }}>
                      识别业务标签 (Domain Tags)
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {(activeTicket.triage?.tags ?? activeTicket.tags ?? []).map(tag => {
                        const tc = stringToColor(tag)
                        return (
                          <span
                            key={tag}
                            style={{
                              fontSize: '11px',
                              padding: '2px 8px',
                              borderRadius: 'var(--dsw-radius-xs, 4px)',
                              background: tc.bg,
                              color: tc.color,
                              border: `1px solid ${tc.border}`,
                              fontWeight: 600,
                            }}
                          >
                            #{tag}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Matched rules tags */}
                {activeTicket.triage?.matchedRules && activeTicket.triage.matchedRules.length > 0 && (
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: COLORS.secondary, marginBottom: '4px' }}>
                      {t('triageMatchedRules')}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {activeTicket.triage.matchedRules.map((rule, idx) => (
                        <span
                          key={idx}
                          style={{
                            fontSize: '11px',
                            padding: '2px 8px',
                            borderRadius: '999px',
                            background: 'rgba(37, 99, 235, 0.08)',
                            color: COLORS.brand,
                            border: `1px solid ${COLORS.borderSubtle}`,
                            fontWeight: 500,
                          }}
                        >
                          ✓ {rule}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Reasoning narrative */}
                {activeTicket.triage?.reasoning && (
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: COLORS.secondary, marginBottom: '4px' }}>
                      {t('triageReasoning')}
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        lineHeight: '1.6',
                        color: COLORS.text,
                        background: COLORS.surface,
                        border: `1px solid ${COLORS.borderSubtle}`,
                        borderRadius: 'var(--dsw-radius-sm, 6px)',
                        padding: '8px 12px',
                        whiteSpace: 'pre-line',
                      }}
                    >
                      {activeTicket.triage.reasoning}
                    </div>
                  </div>
                )}
              </div>

              {/* Mandate & Metadata Grid */}
              <div
                style={{
                  background: COLORS.surfaceAlt,
                  border: `1px solid ${COLORS.borderSubtle}`,
                  borderRadius: 'var(--dsw-radius-md, 8px)',
                  padding: '12px',
                  fontSize: '12px',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '8px 16px',
                  marginBottom: '16px',
                }}
              >
                <div>
                  <span style={{ color: COLORS.secondary }}>{t('targetWorkspace')}: </span>
                  <span style={{ fontWeight: 500, fontFamily: 'var(--dsw-font-mono, monospace)', color: COLORS.text }}>{activeTicket.workspace.sourceRoot}</span>
                </div>
                <div>
                  <span style={{ color: COLORS.secondary }}>{t('source')}: </span>
                  <span style={{ fontWeight: 500, color: COLORS.text }}>
                    {getSourceMeta(activeTicket.source).icon} {getSourceMeta(activeTicket.source).label} ({activeTicket.source})
                  </span>
                </div>
                <div>
                  <span style={{ color: COLORS.secondary }}>{t('priorityLabel')}: </span>
                  <span style={{ fontWeight: 500, color: COLORS.text }}>
                    {getPriorityMeta(activeTicket.priority).dot} {getPriorityMeta(activeTicket.priority).label}
                  </span>
                </div>
                <div>
                  <span style={{ color: COLORS.secondary }}>{t('scheduleLabel')}: </span>
                  <span style={{ fontWeight: 500, color: COLORS.text }}>
                    {activeTicket.scheduleMode === 'nightly' ? '🌙 夜间低峰' : activeTicket.scheduleMode === 'scheduled' ? '🕒 定时' : '⚡ 立即执行'}
                  </span>
                </div>
                <div>
                  <span style={{ color: COLORS.secondary }}>{t('modelLabel')}: </span>
                  <span style={{ fontWeight: 500, color: COLORS.text }}>{activeTicket.mandate.model?.model || 'default'}</span>
                </div>
                <div>
                  <span style={{ color: COLORS.secondary }}>{t('permissionLabel')}: </span>
                  <span style={{ fontWeight: 500, color: COLORS.text }}>{activeTicket.mandate.permissionPreset || 'workspace-write'}</span>
                </div>
                <div>
                  <span style={{ color: COLORS.secondary }}>{t('hopCount')}: </span>
                  <span style={{ fontWeight: 500, color: COLORS.text }}>{activeTicket.hopCount}</span>
                </div>
                {activeTicket.assignment?.startedAt && (
                  <div>
                    <span style={{ color: COLORS.secondary }}>{t('elapsed')}: </span>
                    <span style={{ fontWeight: 500, color: COLORS.text }}>
                      {activeTicket.assignment.endedAt
                        ? `${((activeTicket.assignment.endedAt - activeTicket.assignment.startedAt) / 1000).toFixed(1)}s`
                        : `${((Date.now() - activeTicket.assignment.startedAt) / 1000).toFixed(0)}s (running)`}
                    </span>
                  </div>
                )}
                {activeTicket.workspace.worktree?.branch && (
                  <div style={{ gridColumn: 'span 2' }}>
                    <span style={{ color: COLORS.secondary }}>{t('worktree')}: </span>
                    <span style={{ color: COLORS.success, fontWeight: 600 }}>🌿 {activeTicket.workspace.worktree.branch}</span>
                    {activeTicket.workspace.worktree.path && (
                      <span style={{ color: COLORS.tertiary, fontFamily: 'var(--dsw-font-mono, monospace)', marginLeft: '6px' }}>({activeTicket.workspace.worktree.path})</span>
                    )}
                  </div>
                )}
              </div>

              {/* Original Instruction / Prompt */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '4px' }}>
                  {t('originalInstruction')}
                </label>
                <div
                  style={{
                    background: COLORS.surface,
                    border: `1px solid ${COLORS.borderSubtle}`,
                    borderRadius: 'var(--dsw-radius-sm, 6px)',
                    padding: '10px 12px',
                    fontSize: '12px',
                    color: COLORS.text,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {activeTicket.mandate.instruction}
                </div>
              </div>

              {/* Follow-up Inputs Timeline */}
              {activeTicket.inputs.length > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '6px' }}>
                    {t('followupsTitle')} ({activeTicket.inputs.length})
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {activeTicket.inputs.map(input => (
                      <div
                        key={input.id}
                        style={{
                          background: COLORS.surface,
                          border: `1px solid ${COLORS.borderSubtle}`,
                          borderRadius: 'var(--dsw-radius-sm, 6px)',
                          padding: '6px 10px',
                          fontSize: '12px',
                        }}
                      >
                        <div style={{ color: COLORS.tertiary, fontSize: '10px', marginBottom: '2px' }}>
                          {new Date(input.receivedAt).toLocaleTimeString()} · Event {input.eventId}
                        </div>
                        <div style={{ color: COLORS.text }}>{input.text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px', paddingTop: '12px', borderTop: `1px solid ${COLORS.borderSubtle}` }}>
              <button
                type="button"
                onClick={() => setSelectedTicket(null)}
                style={buttonBaseStyle}
              >
                {t('close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
