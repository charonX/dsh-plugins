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

export function KanbanPage({ t, initialWorkspaces }: KanbanPageProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState<KernelStateSnapshot | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceItemView[]>(initialWorkspaces ?? [])
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState(
    initialWorkspaces?.[0]?.path ?? ''
  )
  const [threadSelection, setThreadSelection] = useState('')
  const [customThreadId, setCustomThreadId] = useState('')
  const [loading, setLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [summary, setSummary] = useState('')

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
          summary: summary.trim(),
          threadId: finalThreadId,
          payload: { workspacePath: effectiveWorkspacePath },
        }),
      })
      setSummary('')
      setThreadSelection('')
      setCustomThreadId('')
      setDialogOpen(false)
      await fetchSnapshot()
    } catch (err) {
      alert(`Error creating task: ${String(err)}`)
    }
  }

  const tickets = snapshot?.tickets ?? []
  const pending = tickets.filter(t => t.status === 'pending')
  const running = tickets.filter(t => t.status === 'running')
  const attention = tickets.filter(t => t.status === 'waiting_attention')
  const done = tickets.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'circuit_broken')

  const currentWorkspace = workspaces.find(w => w.path === selectedWorkspacePath) || workspaces[0]
  const availableSessions = currentWorkspace?.sessions ?? []

  const renderCard = (ticket: Ticket) => (
    <div
      key={ticket.id}
      style={{
        background: 'var(--dsh-bg-card, #ffffff)',
        border: '1px solid var(--dsh-border-color, #e5e7eb)',
        borderRadius: '8px',
        padding: '12px',
        marginBottom: '10px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span style={{ fontSize: '11px', color: '#6b7280', fontFamily: 'monospace' }}>{ticket.id}</span>
        <span
          style={{
            fontSize: '11px',
            padding: '2px 6px',
            borderRadius: '4px',
            background: ticket.mandate.intent === 'bugfix' ? '#fee2e2' : '#e0e7ff',
            color: ticket.mandate.intent === 'bugfix' ? '#991b1b' : '#3730a3',
            fontWeight: 500,
          }}
        >
          {ticket.mandate.intent}
        </span>
      </div>

      <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: '#111827' }}>
        {ticket.title}
      </div>

      <div style={{ fontSize: '11px', color: '#4b5563', marginBottom: '6px' }}>
        <div>Source: <b>{ticket.source}</b> · Hop: <b>{ticket.hopCount}</b></div>
        {ticket.workspace.worktree?.branch && (
          <div style={{ color: '#047857', marginTop: '2px' }}>
            🌿 {ticket.workspace.worktree.branch}
          </div>
        )}
        {ticket.inputs.length > 0 && (
          <div style={{ color: '#6366f1', marginTop: '2px' }}>
            💬 {ticket.inputs.length} {t('inputsCount')}
          </div>
        )}
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
                onClick={() => handleResolveAttention(ticket.id, opt.value)}
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
    </div>
  )
}
