import React, { useEffect, useState, useCallback } from 'react'
import type { KernelStateSnapshot, Ticket } from '../shared/types.ts'
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

/** Deterministic pastel color generator based on any arbitrary string */
export function stringToColor(str: string): { bg: string; color: string; border: string } {
  let hash = 0
  const clean = (str || 'default').trim()
  for (let i = 0; i < clean.length; i++) {
    hash = clean.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash % 360)
  return {
    bg: `hsl(${hue}, 85%, 95%)`,
    color: `hsl(${hue}, 80%, 26%)`,
    border: `hsl(${hue}, 50%, 82%)`,
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
      return { label: 'P0 紧急', bg: '#fee2e2', color: '#dc2626', dot: '🔴' }
    case 'p1':
      return { label: 'P1 高优', bg: '#ffedd5', color: '#c2410c', dot: '🟠' }
    case 'p2':
      return { label: 'P2 普通', bg: '#eff6ff', color: '#2563eb', dot: '🔵' }
    case 'p3':
      return { label: 'P3 低优', bg: '#f3f4f6', color: '#4b5563', dot: '⚪' }
    default:
      return { label: 'P2 普通', bg: '#eff6ff', color: '#2563eb', dot: '🔵' }
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

  useEffect(() => {
    void fetchSnapshot()
    void fetchWorkspaces()
    const timer = setInterval(() => {
      void fetchSnapshot()
    }, 4000)
    return () => clearInterval(timer)
  }, [fetchSnapshot, fetchWorkspaces])

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
            model: selectedModel !== 'default' ? { model: selectedModel } : undefined,
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
          background: 'var(--dsh-bg-card, #ffffff)',
          border: '1px solid var(--dsh-border-color, #e5e7eb)',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '10px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          cursor: 'pointer',
          transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = '#93c5fd'
          e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0,0,0,0.1)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--dsh-border-color, #e5e7eb)'
          e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)'
        }}
      >
        {/* Header: ID + Source + Priority */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', color: '#6b7280', fontFamily: 'monospace', fontWeight: 600 }}>{ticket.id}</span>
            <span
              style={{
                fontSize: '10px',
                padding: '1px 6px',
                borderRadius: '4px',
                background: src.bg,
                color: src.color,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '2px',
              }}
            >
              {src.icon} {src.label}
            </span>
          </div>
          <span
            style={{
              fontSize: '11px',
              padding: '1px 6px',
              borderRadius: '4px',
              background: prio.bg,
              color: prio.color,
              fontWeight: 700,
            }}
          >
            {prio.dot} {prio.label}
          </span>
        </div>

        {/* Title */}
        <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: '#111827', lineHeight: '1.4' }}>
          {ticket.title}
        </div>

        {/* Badges row: Category + Tags + Schedule */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
          <span
            style={{
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '4px',
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
                  padding: '2px 6px',
                  borderRadius: '4px',
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
                padding: '2px 8px',
                borderRadius: '4px',
                background: isNightlyPending ? '#fef3c7' : '#f3f4f6',
                color: isNightlyPending ? '#92400e' : '#4b5563',
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
                padding: '2px 8px',
                borderRadius: '4px',
                background: '#f1f5f9',
                color: '#475569',
                fontWeight: 600,
              }}
            >
              🕒 定时
            </span>
          )}

          {ticket.workspace.worktree?.branch && (
            <span style={{ fontSize: '11px', color: '#047857', fontWeight: 500 }}>
              🌿 {ticket.workspace.worktree.branch}
            </span>
          )}

          {ticket.inputs.length > 0 && (
            <span style={{ fontSize: '11px', color: '#6366f1', fontWeight: 500 }}>
              💬 {ticket.inputs.length} {t('inputsCount')}
            </span>
          )}
        </div>

        {/* Result summary snippet */}
        {hasResult && (
          <div
            style={{
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              borderRadius: '6px',
              padding: '6px 8px',
              fontSize: '11px',
              color: '#166534',
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
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '6px',
              padding: '6px 8px',
              fontSize: '11px',
              color: '#991b1b',
              marginBottom: '8px',
            }}
          >
            ❌ {ticket.assignment!.error}
          </div>
        )}

        {/* Card footer actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px', paddingTop: '6px', borderTop: '1px solid #f3f4f6' }}>
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
                  borderRadius: '4px',
                  border: '1px solid #bfdbfe',
                  background: '#eff6ff',
                  color: '#1d4ed8',
                  cursor: 'pointer',
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {t('openSession')}
              </button>
            ) : (
              <span style={{ fontSize: '11px', color: '#9ca3af' }}>Hop: {ticket.hopCount}</span>
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
                  borderRadius: '4px',
                  border: 'none',
                  background: '#2563eb',
                  color: '#ffffff',
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
                color: '#2563eb',
                fontWeight: 500,
              }}
            >
              {t('viewDetails')} →
            </span>
          </div>
        </div>

        {ticket.status === 'waiting_attention' && ticket.attention && (
          <div
            style={{
              background: '#fffbeb',
              border: '1px solid #fef3c7',
              borderRadius: '6px',
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
                    borderRadius: '4px',
                    border: 'none',
                    background: opt.style === 'danger' ? '#ef4444' : '#10b981',
                    color: '#ffffff',
                    cursor: 'pointer',
                    fontWeight: 500,
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

  const renderColumn = (title: string, count: number, items: Ticket[], headerBg: string) => (
    <div
      style={{
        flex: 1,
        minWidth: '220px',
        background: 'var(--dsh-bg-column, #f9fafb)',
        borderRadius: '8px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px',
          paddingBottom: '8px',
          borderBottom: '2px solid',
          borderColor: headerBg,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: '13px' }}>{title}</span>
        <span
          style={{
            background: headerBg,
            color: '#ffffff',
            padding: '2px 8px',
            borderRadius: '12px',
            fontSize: '11px',
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items.length === 0 ? (
          <div style={{ color: '#9ca3af', fontSize: '12px', textAlign: 'center', marginTop: '20px' }}>
            {t('noTickets')}
          </div>
        ) : (
          items.map(renderCard)
        )}
      </div>
    </div>
  )

  return (
    <div style={{ padding: '24px', height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>{t('title')}</h2>
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#6b7280' }}>{t('subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => void fetchSnapshot()}
            disabled={loading}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              background: '#ffffff',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            {t('refresh')}
          </button>
          <button
            onClick={() => {
              void fetchWorkspaces()
              setDialogOpen(true)
            }}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: 'none',
              background: '#2563eb',
              color: '#ffffff',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('createTask')}
          </button>
        </div>
      </div>

      {/* Kanban Board */}
      <div style={{ flex: 1, display: 'flex', gap: '16px', overflowX: 'auto' }}>
        {renderColumn(t('colPending'), pending.length, pending, '#6b7280')}
        {renderColumn(t('colRunning'), running.length, running, '#2563eb')}
        {renderColumn(t('colAttention'), attention.length, attention, '#d97706')}
        {renderColumn(t('colDone'), done.length, done, '#059669')}
      </div>

      {/* Create Task Modal */}
      {dialogOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: '10px',
              padding: '24px',
              width: '480px',
              maxWidth: '90%',
              boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)',
            }}
          >
            <h3 style={{ margin: '0 0 16px 0', fontSize: '16px' }}>{t('newTaskTitle')}</h3>
            <form onSubmit={handleCreateTask}>
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {t('summaryLabel')}
                </label>
                <textarea
                  value={summary}
                  onChange={e => setSummary(e.target.value)}
                  placeholder={t('summaryPlaceholder')}
                  required
                  rows={3}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '6px',
                    border: '1px solid #d1d5db',
                    fontSize: '13px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Workspace Selector (Required Dropdown) */}
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {t('workspaceLabel')}
                </label>
                <select
                  value={effectiveWorkspacePath}
                  onChange={e => {
                    setSelectedWorkspacePath(e.target.value)
                    setThreadSelection('')
                  }}
                  required
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '6px',
                    border: '1px solid #d1d5db',
                    fontSize: '13px',
                    boxSizing: 'border-box',
                    backgroundColor: '#ffffff',
                  }}
                >
                  {workspaces.map(w => (
                    <option key={w.id} value={w.path}>
                      {w.title} ({w.path})
                    </option>
                  ))}
                </select>
              </div>

              {/* Linked Thread / Conversation Selector */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {t('threadIdLabel')}
                </label>
                <select
                  value={threadSelection}
                  onChange={e => setThreadSelection(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '6px',
                    border: '1px solid #d1d5db',
                    fontSize: '13px',
                    boxSizing: 'border-box',
                    backgroundColor: '#ffffff',
                  }}
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
                    style={{
                      width: '100%',
                      marginTop: '8px',
                      padding: '8px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '13px',
                      boxSizing: 'border-box',
                    }}
                  />
                )}
              </div>

              {/* Category and Source Grid (Open & Semantic, with datalist & quick pills) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600 }}>
                      {t('categoryLabel')}
                    </label>
                    <span style={{ fontSize: '11px', color: '#6366f1' }}>🤖 Router 智能研判</span>
                  </div>
                  <input
                    type="text"
                    value={selectedCategory}
                    onChange={e => setSelectedCategory(e.target.value)}
                    placeholder="留空自动研判，或输入自定义分类..."
                    list="autoloop-categories"
                    style={{
                      width: '100%',
                      padding: '8px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '13px',
                      boxSizing: 'border-box',
                      backgroundColor: '#ffffff',
                    }}
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
                          padding: '1px 6px',
                          borderRadius: '10px',
                          border: '1px solid #e2e8f0',
                          background: selectedCategory === c ? '#e0e7ff' : '#f8fafc',
                          color: selectedCategory === c ? '#3730a3' : '#64748b',
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
                        style={{ fontSize: '10px', padding: '1px 4px', border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}
                      >
                        ✕ 重置
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600 }}>
                      {t('sourceFormLabel')}
                    </label>
                    <span style={{ fontSize: '11px', color: '#6366f1' }}>🤖 Router 自动提取</span>
                  </div>
                  <input
                    type="text"
                    value={selectedSource}
                    onChange={e => setSelectedSource(e.target.value)}
                    placeholder="留空自动识别渠道，或输入自定义来源..."
                    list="autoloop-sources"
                    style={{
                      width: '100%',
                      padding: '8px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '13px',
                      boxSizing: 'border-box',
                      backgroundColor: '#ffffff',
                    }}
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
                          padding: '1px 6px',
                          borderRadius: '10px',
                          border: '1px solid #e2e8f0',
                          background: selectedSource === s ? '#e0e7ff' : '#f8fafc',
                          color: selectedSource === s ? '#3730a3' : '#64748b',
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
                        style={{ fontSize: '10px', padding: '1px 4px', border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}
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
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                    {t('priorityLabel')}
                  </label>
                  <select
                    value={selectedPriority}
                    onChange={e => setSelectedPriority(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '13px',
                      boxSizing: 'border-box',
                      backgroundColor: '#ffffff',
                    }}
                  >
                    <option value="auto">{t('priorityAuto')}</option>
                    <option value="p0">{t('prioP0')}</option>
                    <option value="p1">{t('prioP1')}</option>
                    <option value="p2">{t('prioP2')}</option>
                    <option value="p3">{t('prioP3')}</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                    {t('scheduleLabel')}
                  </label>
                  <select
                    value={selectedSchedule}
                    onChange={e => setSelectedSchedule(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '13px',
                      boxSizing: 'border-box',
                      backgroundColor: '#ffffff',
                    }}
                  >
                    <option value="immediate">{t('scheduleImmediate')}</option>
                    <option value="nightly">{t('scheduleNightly')}</option>
                    <option value="scheduled">{t('scheduleScheduled')}</option>
                  </select>
                </div>
              </div>

              {/* Model and Permission Settings Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                    {t('modelLabel')}
                  </label>
                  <select
                    value={selectedModel}
                    onChange={e => setSelectedModel(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '13px',
                      boxSizing: 'border-box',
                      backgroundColor: '#ffffff',
                    }}
                  >
                    <option value="default">{t('modelDefault')}</option>
                    <option value="deepseek-reasoner">{t('modelReasoner')}</option>
                    <option value="deepseek-chat">{t('modelChat')}</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                    {t('permissionLabel')}
                  </label>
                  <select
                    value={selectedPermission}
                    onChange={e => setSelectedPermission(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '13px',
                      boxSizing: 'border-box',
                      backgroundColor: '#ffffff',
                    }}
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
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: '1px solid #d1d5db',
                    background: '#ffffff',
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  style={{
                    padding: '6px 16px',
                    borderRadius: '6px',
                    border: 'none',
                    background: '#2563eb',
                    color: '#ffffff',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
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
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setSelectedTicket(null)}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: '12px',
              padding: '24px',
              width: '680px',
              maxWidth: '92%',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
              boxSizing: 'border-box',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                  <span style={{ fontSize: '12px', color: '#6b7280', fontFamily: 'monospace', fontWeight: 600 }}>{activeTicket.id}</span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      background: activeTicket.status === 'completed' ? '#dcfce7' : activeTicket.status === 'running' ? '#dbeafe' : activeTicket.status === 'waiting_attention' ? '#fef3c7' : '#f3f4f6',
                      color: activeTicket.status === 'completed' ? '#166534' : activeTicket.status === 'running' ? '#1e40af' : activeTicket.status === 'waiting_attention' ? '#92400e' : '#374151',
                      fontWeight: 600,
                    }}
                  >
                    {activeTicket.status.toUpperCase()}
                  </span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: getCategoryMeta(activeTicket.mandate.intent).bg,
                      color: getCategoryMeta(activeTicket.mandate.intent).color,
                      fontWeight: 600,
                    }}
                  >
                    {getCategoryMeta(activeTicket.mandate.intent).icon} {activeTicket.triage?.categoryLabel || getCategoryMeta(activeTicket.mandate.intent).label}
                  </span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: getPriorityMeta(activeTicket.priority).bg,
                      color: getPriorityMeta(activeTicket.priority).color,
                      fontWeight: 700,
                    }}
                  >
                    {getPriorityMeta(activeTicket.priority).dot} {getPriorityMeta(activeTicket.priority).label}
                  </span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: getSourceMeta(activeTicket.source).bg,
                      color: getSourceMeta(activeTicket.source).color,
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
                        borderRadius: '4px',
                        background: '#fef3c7',
                        color: '#92400e',
                        fontWeight: 600,
                      }}
                    >
                      🌙 夜间低峰
                    </span>
                  )}
                </div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#111827' }}>
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
                  color: '#9ca3af',
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
                    background: '#fffbeb',
                    border: '1px solid #fde68a',
                    borderRadius: '8px',
                    padding: '12px 16px',
                    marginBottom: '16px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '12px',
                  }}
                >
                  <div style={{ fontSize: '12px', color: '#92400e', lineHeight: '1.5' }}>
                    {t('nightlyNotice')}
                  </div>
                  <button
                    type="button"
                    disabled={runningNowId === activeTicket.id}
                    onClick={() => void handleRunNow(activeTicket.id)}
                    style={{
                      padding: '6px 14px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: '#2563eb',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      marginLeft: '8px',
                    }}
                  >
                    {runningNowId === activeTicket.id ? t('runningNow') : t('runNow')}
                  </button>
                </div>
              )}
              {/* Session Jump Banner (if sessionId exists) */}
              {activeTicket.assignment?.sessionId && (
                <div
                  style={{
                    background: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    borderRadius: '8px',
                    padding: '12px 16px',
                    marginBottom: '16px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '12px',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e40af' }}>
                      {t('associatedSession')}: <code style={{ fontSize: '12px', background: '#dbeafe', padding: '2px 4px', borderRadius: '4px' }}>{activeTicket.assignment.sessionId}</code>
                    </div>
                    <div style={{ fontSize: '11px', color: '#3b82f6', marginTop: '3px' }}>
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
                      style={{
                        padding: '6px 14px',
                        borderRadius: '6px',
                        border: 'none',
                        background: '#2563eb',
                        color: '#ffffff',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t('openSessionInSidebar')}
                    </button>
                  )}
                </div>
              )}

              {/* Execution Result Box */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>
                    {t('resultTitle')}
                  </label>
                  {activeTicket.assignment?.resultSummary && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {copyNotice && (
                        <span style={{ fontSize: '11px', color: '#059669', fontWeight: 500 }}>
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
                        style={{
                          fontSize: '11px',
                          padding: '3px 8px',
                          borderRadius: '4px',
                          border: '1px solid #d1d5db',
                          background: '#ffffff',
                          cursor: 'pointer',
                        }}
                      >
                        {t('copyResult')}
                      </button>
                    </div>
                  )}
                </div>

                <div
                  style={{
                    background: '#f9fafb',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    padding: '12px',
                    minHeight: '80px',
                    maxHeight: '260px',
                    overflowY: 'auto',
                    fontSize: '13px',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {activeTicket.status === 'running' ? (
                    <div style={{ color: '#2563eb', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>⏳</span>
                      {t('runningHint')}
                    </div>
                  ) : activeTicket.assignment?.error ? (
                    <div style={{ color: '#b91c1c' }}>
                      <strong>Error:</strong> {activeTicket.assignment.error}
                    </div>
                  ) : activeTicket.assignment?.resultSummary ? (
                    activeTicket.assignment.resultSummary
                  ) : (
                    <span style={{ color: '#9ca3af' }}>{t('noResult')}</span>
                  )}
                </div>
              </div>

              {/* Attention prompt resolution if waiting */}
              {activeTicket.status === 'waiting_attention' && activeTicket.attention && (
                <div
                  style={{
                    background: '#fffbeb',
                    border: '1px solid #fef3c7',
                    borderRadius: '8px',
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
                          borderRadius: '6px',
                          border: 'none',
                          background: opt.style === 'danger' ? '#ef4444' : '#10b981',
                          color: '#ffffff',
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
                  background: '#f8fafc',
                  border: '1px solid #cbd5e1',
                  borderRadius: '10px',
                  padding: '14px',
                  marginBottom: '16px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#1e293b', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>🧠</span>
                    <span>{t('triageTitle')}</span>
                  </div>
                  {activeTicket.triage?.evaluatedAt && (
                    <span style={{ fontSize: '11px', color: '#64748b' }}>
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
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '10px',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '11px' }}>{t('triageCategory')}</span>
                    <span style={{ fontWeight: 600, color: '#1e293b' }}>
                      {getCategoryMeta(activeTicket.mandate.intent).icon} {activeTicket.triage?.categoryLabel || getCategoryMeta(activeTicket.mandate.intent).label}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '11px' }}>{t('triagePriority')}</span>
                    <span style={{ fontWeight: 600, color: '#1e293b' }}>
                      {getPriorityMeta(activeTicket.priority).dot} {getPriorityMeta(activeTicket.priority).label}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '11px' }}>{t('triageSchedule')}</span>
                    <span style={{ fontWeight: 600, color: '#1e293b' }}>
                      {activeTicket.scheduleMode === 'nightly' ? '🌙 夜间低峰' : activeTicket.scheduleMode === 'scheduled' ? '🕒 定时' : '⚡ 立即执行'}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '11px' }}>{t('triageModel')}</span>
                    <span style={{ fontWeight: 600, color: '#1e293b' }}>
                      {activeTicket.mandate.model?.model || '系统默认'}
                    </span>
                  </div>
                </div>

                {/* Domain tags if present */}
                {((activeTicket.triage?.tags && activeTicket.triage.tags.length > 0) || (activeTicket.tags && activeTicket.tags.length > 0)) && (
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
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
                              borderRadius: '6px',
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
                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                      {t('triageMatchedRules')}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {activeTicket.triage.matchedRules.map((rule, idx) => (
                        <span
                          key={idx}
                          style={{
                            fontSize: '11px',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            background: '#e0e7ff',
                            color: '#3730a3',
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
                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                      {t('triageReasoning')}
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        lineHeight: '1.6',
                        color: '#334155',
                        background: '#f1f5f9',
                        borderRadius: '6px',
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
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  padding: '12px',
                  fontSize: '12px',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '8px 16px',
                  marginBottom: '16px',
                }}
              >
                <div>
                  <span style={{ color: '#64748b' }}>{t('targetWorkspace')}: </span>
                  <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>{activeTicket.workspace.sourceRoot}</span>
                </div>
                <div>
                  <span style={{ color: '#64748b' }}>{t('source')}: </span>
                  <span style={{ fontWeight: 500 }}>
                    {getSourceMeta(activeTicket.source).icon} {getSourceMeta(activeTicket.source).label} ({activeTicket.source})
                  </span>
                </div>
                <div>
                  <span style={{ color: '#64748b' }}>{t('priorityLabel')}: </span>
                  <span style={{ fontWeight: 500 }}>
                    {getPriorityMeta(activeTicket.priority).dot} {getPriorityMeta(activeTicket.priority).label}
                  </span>
                </div>
                <div>
                  <span style={{ color: '#64748b' }}>{t('scheduleLabel')}: </span>
                  <span style={{ fontWeight: 500 }}>
                    {activeTicket.scheduleMode === 'nightly' ? '🌙 夜间低峰' : activeTicket.scheduleMode === 'scheduled' ? '🕒 定时' : '⚡ 立即执行'}
                  </span>
                </div>
                <div>
                  <span style={{ color: '#64748b' }}>{t('modelLabel')}: </span>
                  <span style={{ fontWeight: 500 }}>{activeTicket.mandate.model?.model || 'default'}</span>
                </div>
                <div>
                  <span style={{ color: '#64748b' }}>{t('permissionLabel')}: </span>
                  <span style={{ fontWeight: 500 }}>{activeTicket.mandate.permissionPreset || 'workspace-write'}</span>
                </div>
                <div>
                  <span style={{ color: '#64748b' }}>{t('hopCount')}: </span>
                  <span style={{ fontWeight: 500 }}>{activeTicket.hopCount}</span>
                </div>
                {activeTicket.assignment?.startedAt && (
                  <div>
                    <span style={{ color: '#64748b' }}>{t('elapsed')}: </span>
                    <span style={{ fontWeight: 500 }}>
                      {activeTicket.assignment.endedAt
                        ? `${((activeTicket.assignment.endedAt - activeTicket.assignment.startedAt) / 1000).toFixed(1)}s`
                        : `${((Date.now() - activeTicket.assignment.startedAt) / 1000).toFixed(0)}s (running)`}
                    </span>
                  </div>
                )}
                {activeTicket.workspace.worktree?.branch && (
                  <div style={{ gridColumn: 'span 2' }}>
                    <span style={{ color: '#64748b' }}>{t('worktree')}: </span>
                    <span style={{ color: '#047857', fontWeight: 600 }}>🌿 {activeTicket.workspace.worktree.branch}</span>
                    {activeTicket.workspace.worktree.path && (
                      <span style={{ color: '#6b7280', fontFamily: 'monospace', marginLeft: '6px' }}>({activeTicket.workspace.worktree.path})</span>
                    )}
                  </div>
                )}
              </div>

              {/* Original Instruction / Prompt */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>
                  {t('originalInstruction')}
                </label>
                <div
                  style={{
                    background: '#ffffff',
                    border: '1px solid #e5e7eb',
                    borderRadius: '6px',
                    padding: '8px 12px',
                    fontSize: '12px',
                    color: '#1f2937',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {activeTicket.mandate.instruction}
                </div>
              </div>

              {/* Follow-up Inputs Timeline */}
              {activeTicket.inputs.length > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#374151', marginBottom: '6px' }}>
                    {t('followupsTitle')} ({activeTicket.inputs.length})
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {activeTicket.inputs.map(input => (
                      <div
                        key={input.id}
                        style={{
                          background: '#ffffff',
                          border: '1px solid #e5e7eb',
                          borderRadius: '6px',
                          padding: '6px 10px',
                          fontSize: '12px',
                        }}
                      >
                        <div style={{ color: '#6b7280', fontSize: '10px', marginBottom: '2px' }}>
                          {new Date(input.receivedAt).toLocaleTimeString()} · Event {input.eventId}
                        </div>
                        <div style={{ color: '#111827' }}>{input.text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px', paddingTop: '12px', borderTop: '1px solid #f3f4f6' }}>
              <button
                type="button"
                onClick={() => setSelectedTicket(null)}
                style={{
                  padding: '6px 16px',
                  borderRadius: '6px',
                  border: '1px solid #d1d5db',
                  background: '#ffffff',
                  fontSize: '12px',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
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
