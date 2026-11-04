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
  border: `0.5px solid ${COLORS.borderStrong}`,
  borderRadius: 'var(--dsw-radius-md, 8px)',
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
  height: '32px',
  border: `0.5px solid ${COLORS.borderStrong}`,
  borderRadius: 'var(--dsw-radius-md, 8px)',
  background: COLORS.surfaceAlt,
  color: COLORS.text,
  padding: '0 10px',
  fontSize: '13px',
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  height: 'auto',
  minHeight: '70px',
  padding: '8px 10px',
  lineHeight: '1.5',
}

export interface SelectOption {
  value: string
  label: string
  subLabel?: string
  badge?: string
  badgeColor?: { bg: string; color: string }
}

export interface SelectGroup {
  id: string
  label?: string
  options: SelectOption[]
}

export interface DshSelectProps {
  value: string
  onChange: (value: string) => void
  options?: SelectOption[]
  groups?: SelectGroup[]
  placeholder?: string
  disabled?: boolean
  style?: React.CSSProperties
}

/**
 * Custom Dropdown adhering strictly to DeepSeek Harness UI Primitives & Design Tokens
 * Features 32px height, 0.5px subtle border, 8px radius, rotating 12px DSH chevron,
 * floating elevated popover panel with hover highlights, groups, badges, and active checkmarks.
 */
export function DshSelect({
  value,
  onChange,
  options,
  groups,
  placeholder = '请选择...',
  disabled = false,
  style,
}: DshSelectProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const [openUpwards, setOpenUpwards] = useState(false)
  const [hoveredValue, setHoveredValue] = useState<string | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

  const allOptions = React.useMemo(() => {
    if (groups && groups.length > 0) {
      return groups.flatMap(g => g.options)
    }
    return options || []
  }, [groups, options])

  const selectedOption = allOptions.find(opt => opt.value === value) || (value ? { value, label: value } : null)

  const toggleDropdown = () => {
    if (disabled) return
    if (!isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      if (spaceBelow < 230 && rect.top > 230) {
        setOpenUpwards(true)
      } else {
        setOpenUpwards(false)
      }
    }
    setIsOpen(prev => !prev)
  }

  React.useEffect(() => {
    if (!isOpen) return

    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        userSelect: 'none',
        ...style,
      }}
    >
      {/* Trigger Button adhering to DSH selectInput & ModelSelect */}
      <div
        role="combobox"
        aria-expanded={isOpen}
        tabIndex={disabled ? -1 : 0}
        onClick={toggleDropdown}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleDropdown()
          }
        }}
        className="dsh-autoloop-select-trigger"
        style={{
          boxSizing: 'border-box',
          width: '100%',
          height: '32px',
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          background: COLORS.surfaceAlt,
          border: `0.5px solid ${isOpen ? COLORS.brand : COLORS.borderStrong}`,
          borderRadius: 'var(--dsw-radius-md, 8px)',
          color: COLORS.text,
          fontSize: '13px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          outline: 'none',
          boxShadow: isOpen ? '0 0 0 2px rgba(37, 99, 235, 0.15)' : 'none',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, overflow: 'hidden' }}>
          {selectedOption ? (
            <>
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontWeight: 500,
                  color: COLORS.text,
                }}
              >
                {selectedOption.label}
              </span>
              {selectedOption.badge && (
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: '10px',
                    padding: '1px 5px',
                    borderRadius: 'var(--dsw-radius-xs, 4px)',
                    background: selectedOption.badgeColor?.bg || 'rgba(37, 99, 235, 0.08)',
                    color: selectedOption.badgeColor?.color || COLORS.brand,
                    fontWeight: 600,
                  }}
                >
                  {selectedOption.badge}
                </span>
              )}
              {selectedOption.subLabel && (
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: '11px',
                    color: COLORS.tertiary,
                  }}
                >
                  ({selectedOption.subLabel})
                </span>
              )}
            </>
          ) : (
            <span style={{ color: COLORS.tertiary }}>{placeholder}</span>
          )}
        </div>

        {/* DSH 12px Chevron Icon with 180deg smooth animation */}
        <div
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--dsw-alias-label-caption, #81858c)',
            transform: isOpen ? 'rotate(180deg)' : 'none',
            transition: 'transform 140ms ease',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      {/* Floating Popover Panel matching Menu & ModelSelect */}
      {isOpen && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            ...(openUpwards ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
            left: 0,
            right: 0,
            zIndex: 1100,
            boxSizing: 'border-box',
            background: COLORS.surface,
            border: `0.5px solid ${COLORS.border}`,
            borderRadius: 'var(--dsw-radius-lg, 10px)',
            boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.16))',
            padding: '4px',
            maxHeight: '240px',
            overflowY: 'auto',
          }}
          onClick={e => e.stopPropagation()}
        >
          {groups && groups.length > 0 ? (
            groups.map((group, groupIdx) => (
              <div key={group.id}>
                {groupIdx > 0 && (
                  <div
                    style={{
                      height: '0.5px',
                      background: COLORS.borderSubtle,
                      margin: '4px 6px',
                    }}
                  />
                )}
                {group.label && (
                  <div
                    style={{
                      padding: '6px 8px 3px',
                      fontSize: '11px',
                      fontWeight: 600,
                      color: COLORS.tertiary,
                      letterSpacing: '0.3px',
                    }}
                  >
                    {group.label}
                  </div>
                )}
                {group.options.map(opt => renderOptionItem(opt))}
              </div>
            ))
          ) : (
            allOptions.map(opt => renderOptionItem(opt))
          )}
          {allOptions.length === 0 && (
            <div style={{ padding: '8px', fontSize: '12px', color: COLORS.tertiary, textAlign: 'center' }}>
              无可选项目
            </div>
          )}
        </div>
      )}
    </div>
  )

  function renderOptionItem(opt: SelectOption) {
    const isSelected = opt.value === value
    const isHovered = hoveredValue === opt.value

    return (
      <div
        key={opt.value}
        role="option"
        aria-selected={isSelected}
        onMouseEnter={() => setHoveredValue(opt.value)}
        onMouseLeave={() => setHoveredValue(null)}
        onClick={() => {
          onChange(opt.value)
          setIsOpen(false)
        }}
        className="dsh-autoloop-opt"
        style={{
          minHeight: '32px',
          boxSizing: 'border-box',
          padding: '6px 8px',
          borderRadius: 'var(--dsw-radius-md, 6px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          cursor: 'pointer',
          background: isHovered
            ? COLORS.interactiveHover
            : isSelected
            ? 'rgba(37, 99, 235, 0.05)'
            : 'transparent',
          color: COLORS.text,
          fontSize: '13px',
          lineHeight: '20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, overflow: 'hidden' }}>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: isSelected ? 600 : 400,
              color: isSelected ? COLORS.brand : COLORS.text,
            }}
          >
            {opt.label}
          </span>
          {opt.badge && (
            <span
              style={{
                flexShrink: 0,
                fontSize: '10px',
                padding: '1px 5px',
                borderRadius: 'var(--dsw-radius-xs, 4px)',
                background: opt.badgeColor?.bg || 'rgba(37, 99, 235, 0.08)',
                color: opt.badgeColor?.color || COLORS.brand,
                fontWeight: 600,
              }}
            >
              {opt.badge}
            </span>
          )}
          {opt.subLabel && (
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: '11px',
                color: COLORS.tertiary,
              }}
            >
              ({opt.subLabel})
            </span>
          )}
        </div>

        {/* Selected Checkmark Icon */}
        {isSelected && (
          <div
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              color: COLORS.brand,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M3.5 8.5L6.5 11.5L12.5 5.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}
      </div>
    )
  }
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
  let label = cat || '常规任务'

  if (/ppt|slide|演示/i.test(text)) {
    if (cat === 'ppt') label = 'PPT设计'
  } else if (/ui|壁纸|图标|设计|样式|视觉|主题/i.test(text)) {
    if (cat === 'ui_design') label = '视觉设计'
  } else if (/运营|活动|营销|策略/i.test(text)) {
    if (cat === 'operation') label = '运营策略'
  } else if (/运维|部署|环境|服务器|nginx/i.test(text)) {
    if (cat === 'ops') label = '运维部署'
  } else if (/数据|统计|报表/i.test(text)) {
    if (cat === 'data') label = '数据分析'
  } else if (/bug|error|故障|缺陷|报错|异常|修复/i.test(text)) {
    if (cat === 'bugfix') label = '缺陷修复'
  } else if (/feat|开发|需求|功能/i.test(text)) {
    if (cat === 'feature') label = '功能开发'
  } else if (/重构|治理|解耦|坏味/i.test(text)) {
    if (cat === 'refactor') label = '架构治理'
  } else if (/测试|用例|test|spec/i.test(text)) {
    if (cat === 'testing') label = '测试验证'
  } else if (/文档|doc|手册|方案/i.test(text)) {
    if (cat === 'documentation') label = '文档方案'
  } else if (/审查|review|调研/i.test(text)) {
    if (cat === 'review') label = '审查调研'
  } else if (cat === 'general') {
    label = '常规任务'
  }

  const color = stringToColor(label)
  return {
    label,
    bg: color.bg,
    color: color.color,
    border: color.border,
  }
}

export function getPriorityMeta(prio?: string) {
  switch (prio) {
    case 'p0':
      return { label: 'P0 紧急', bg: 'rgba(239, 68, 68, 0.1)', color: 'var(--dsw-alias-state-error-primary, #dc2626)', border: 'rgba(239, 68, 68, 0.25)' }
    case 'p1':
      return { label: 'P1 高优', bg: 'rgba(245, 158, 11, 0.12)', color: '#c2410c', border: 'rgba(245, 158, 11, 0.3)' }
    case 'p2':
      return { label: 'P2 普通', bg: 'rgba(37, 99, 235, 0.1)', color: 'var(--dsw-alias-brand-primary, #2563eb)', border: 'rgba(37, 99, 235, 0.25)' }
    case 'p3':
      return { label: 'P3 低优', bg: 'rgba(107, 114, 128, 0.1)', color: 'var(--dsw-alias-label-secondary, #4b5563)', border: 'rgba(107, 114, 128, 0.2)' }
    default:
      return { label: 'P2 普通', bg: 'rgba(37, 99, 235, 0.1)', color: 'var(--dsw-alias-brand-primary, #2563eb)', border: 'rgba(37, 99, 235, 0.25)' }
  }
}

export function getSourceMeta(src: string) {
  const text = (src || '').toLowerCase()
  let label = src || '中台创建'

  if (/feishu|飞书|lark/i.test(text)) {
    label = '飞书'
  } else if (/github/i.test(text)) {
    label = 'GitHub'
  } else if (/gitlab/i.test(text)) {
    label = 'GitLab'
  } else if (/sentry/i.test(text)) {
    label = 'Sentry'
  } else if (/jira/i.test(text)) {
    label = 'Jira'
  } else if (/tapd/i.test(text)) {
    label = 'TAPD'
  } else if (/dingtalk|钉钉/i.test(text)) {
    label = '钉钉'
  } else if (/wecom|企业微信|企微/i.test(text)) {
    label = '企业微信'
  } else if (/slack/i.test(text)) {
    label = 'Slack'
  } else if (/cron|巡检|定时/i.test(text)) {
    label = '定时巡检'
  } else if (/邮件|mail/i.test(text)) {
    label = '邮件'
  } else if (src === 'manual-ui' || text === 'manual-ui') {
    label = '中台创建'
  }

  const color = stringToColor(label)
  return {
    label,
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

  const workspaceOptions: SelectOption[] = workspaces.map(w => ({
    value: w.path,
    label: w.title,
    subLabel: w.path,
  }))

  const threadGroups: SelectGroup[] = [
    {
      id: 'default',
      options: [{ value: '', label: t('newThreadOption') }],
    },
    ...(availableSessions.length > 0
      ? [
          {
            id: 'sessions',
            label: t('recentConversationsGroup'),
            options: availableSessions.map(s => ({
              value: `dsh:session:${s.id}`,
              label: s.title,
              subLabel: s.id.slice(0, 8),
            })),
          },
        ]
      : []),
    {
      id: 'custom',
      options: [{ value: '__custom__', label: t('customThreadOption') }],
    },
  ]

  const priorityOptions: SelectOption[] = [
    { value: 'auto', label: t('priorityAuto'), subLabel: 'Router智能评级' },
    { value: 'p0', label: t('prioP0'), badge: '紧急', badgeColor: { bg: 'rgba(239, 68, 68, 0.1)', color: 'var(--dsw-alias-state-error-primary, #ef4444)' } },
    { value: 'p1', label: t('prioP1'), badge: '高优', badgeColor: { bg: 'rgba(245, 158, 11, 0.12)', color: '#c2410c' } },
    { value: 'p2', label: t('prioP2'), badge: '普通', badgeColor: { bg: 'rgba(37, 99, 235, 0.1)', color: 'var(--dsw-alias-brand-primary, #2563eb)' } },
    { value: 'p3', label: t('prioP3'), badge: '低优', badgeColor: { bg: 'rgba(107, 114, 128, 0.1)', color: 'var(--dsw-alias-label-secondary, #4b5563)' } },
  ]

  const scheduleOptions: SelectOption[] = [
    { value: 'immediate', label: t('scheduleImmediate'), subLabel: '研判通过后立即调度执行' },
    { value: 'nightly', label: t('scheduleNightly'), subLabel: '闲时排队执行 (00:00 - 08:00)' },
    { value: 'scheduled', label: t('scheduleScheduled'), subLabel: '按设定定时策略启动' },
  ]

  const modelGroups: SelectGroup[] = [
    {
      id: 'default',
      options: [
        {
          value: 'default',
          label: `${t('modelDefault')}${modelCatalog?.defaultSelection?.model ? ` (${modelCatalog.defaultSelection.model})` : ''}`,
          subLabel: '推荐',
        },
      ],
    },
    ...(modelCatalog?.groups?.map(g => ({
      id: g.id,
      label: g.name || g.id,
      options: g.models.map(m => ({
        value: `${g.id}/${m.id}`,
        label: m.name || m.id,
        badge: m.badge,
      })),
    })) || []),
  ]

  const permissionOptions: SelectOption[] = [
    { value: 'workspace-write', label: t('permWorkspace'), subLabel: '安全沙箱，仅修改指定工作区目录' },
    { value: 'danger-full-access', label: t('permFullAccess'), subLabel: '高危，允许全盘访问与执行高危命令', badge: '高危', badgeColor: { bg: 'rgba(239, 68, 68, 0.1)', color: 'var(--dsw-alias-state-error-primary, #ef4444)' } },
    { value: 'read-only', label: t('permReadOnly'), subLabel: '只读探索，不写入任何代码与文件' },
  ]

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
              }}
            >
              {src.label}
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
            }}
          >
            {prio.label}
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
            }}
          >
            {ticket.triage?.categoryLabel || cat.label}
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
              }}
            >
              {isNightlyPending ? '夜间排队' : '夜间执行'}
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
              定时
            </span>
          )}

          {ticket.workspace.worktree?.branch && (
            <span style={{ fontSize: '11px', color: COLORS.success, fontWeight: 500, display: 'inline-flex', alignItems: 'center' }}>
              分支: {ticket.workspace.worktree.branch}
            </span>
          )}

          {ticket.inputs.length > 0 && (
            <span style={{ fontSize: '11px', color: COLORS.brand, fontWeight: 500 }}>
              {ticket.inputs.length} {t('inputsCount')}
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
            <span style={{ fontWeight: 600 }}>{t('resultLabel')}: </span>
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
            错误: {ticket.assignment!.error}
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
              [待处理] {ticket.attention.question}
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

  const renderColumn = (title: string, count: number, items: Ticket[], headerColor: string) => (
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
        <span style={{ fontWeight: 600, fontSize: '13px', color: COLORS.text }}>{title}</span>
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
      <style>{`
        .dsh-autoloop-select-trigger {
          transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        }
        .dsh-autoloop-select-trigger:hover:not(:disabled) {
          background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)) !important;
          border-color: var(--dsw-alias-border-l4, rgba(0,0,0,0.22)) !important;
        }
        .dsh-autoloop-opt {
          transition: background 0.1s ease;
        }
        .dsh-autoloop-opt:hover {
          background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)) !important;
        }
        .dsh-autoloop-input:focus {
          border-color: var(--dsw-alias-brand-primary, #2563eb) !important;
          box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15) !important;
        }
        .dsh-autoloop-input::placeholder {
          color: var(--dsw-alias-label-tertiary, #9ca3af);
        }
      `}</style>

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
            {t('refresh')}
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
        {renderColumn(t('colPending'), pending.length, pending, COLORS.tertiary)}
        {renderColumn(t('colRunning'), running.length, running, COLORS.brand)}
        {renderColumn(t('colAttention'), attention.length, attention, COLORS.warn)}
        {renderColumn(t('colDone'), done.length, done, COLORS.success)}
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
              border: `0.5px solid ${COLORS.border}`,
              padding: '24px',
              width: '540px',
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
                style={{ background: 'transparent', border: 'none', color: COLORS.tertiary, fontSize: '14px', cursor: 'pointer', padding: '4px' }}
              >
                关闭
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
                  className="dsh-autoloop-input"
                  style={{
                    ...textareaStyle,
                    resize: 'vertical',
                  }}
                />
              </div>

              {/* Workspace Selector (Native DSH Dropdown) */}
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                  {t('workspaceLabel')}
                </label>
                <DshSelect
                  value={effectiveWorkspacePath}
                  onChange={val => {
                    setSelectedWorkspacePath(val)
                    setThreadSelection('')
                  }}
                  options={workspaceOptions}
                />
              </div>

              {/* Linked Thread / Conversation Selector */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                  {t('threadIdLabel')}
                </label>
                <DshSelect
                  value={threadSelection}
                  onChange={val => setThreadSelection(val)}
                  groups={threadGroups}
                />

                {threadSelection === '__custom__' && (
                  <input
                    type="text"
                    value={customThreadId}
                    onChange={e => setCustomThreadId(e.target.value)}
                    placeholder={t('customThreadPlaceholder')}
                    className="dsh-autoloop-input"
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
                    <span style={{ fontSize: '11px', color: COLORS.brand }}>Router 智能研判</span>
                  </div>
                  <input
                    type="text"
                    value={selectedCategory}
                    onChange={e => setSelectedCategory(e.target.value)}
                    placeholder="留空自动研判，或输入自定义分类..."
                    list="autoloop-categories"
                    className="dsh-autoloop-input"
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
                          border: `0.5px solid ${selectedCategory === c ? COLORS.brand : COLORS.borderSubtle}`,
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
                        重置
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: COLORS.text }}>
                      {t('sourceFormLabel')}
                    </label>
                    <span style={{ fontSize: '11px', color: COLORS.brand }}>Router 自动提取</span>
                  </div>
                  <input
                    type="text"
                    value={selectedSource}
                    onChange={e => setSelectedSource(e.target.value)}
                    placeholder="留空自动识别渠道，或输入自定义来源..."
                    list="autoloop-sources"
                    className="dsh-autoloop-input"
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
                          border: `0.5px solid ${selectedSource === s ? COLORS.brand : COLORS.borderSubtle}`,
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
                        重置
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
                  <DshSelect
                    value={selectedPriority}
                    onChange={val => setSelectedPriority(val)}
                    options={priorityOptions}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                    {t('scheduleLabel')}
                  </label>
                  <DshSelect
                    value={selectedSchedule}
                    onChange={val => setSelectedSchedule(val)}
                    options={scheduleOptions}
                  />
                </div>
              </div>

              {/* Dynamic Model (from DSH) and Permission Settings Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                    {t('modelLabel')}
                  </label>
                  <DshSelect
                    value={selectedModel}
                    onChange={val => setSelectedModel(val)}
                    groups={modelGroups}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: COLORS.text, marginBottom: '5px' }}>
                    {t('permissionLabel')}
                  </label>
                  <DshSelect
                    value={selectedPermission}
                    onChange={val => setSelectedPermission(val)}
                    options={permissionOptions}
                  />
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
                    {activeTicket.triage?.categoryLabel || getCategoryMeta(activeTicket.mandate.intent).label}
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
                    {getPriorityMeta(activeTicket.priority).label}
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
                    {getSourceMeta(activeTicket.source).label}
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
                      夜间低峰
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
                  fontSize: '14px',
                  color: COLORS.tertiary,
                  cursor: 'pointer',
                  padding: '4px 8px',
                  lineHeight: 1,
                }}
              >
                关闭
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
                          {t('copied')}
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
                      {t('runningHint')}
                    </div>
                  ) : activeTicket.assignment?.error ? (
                    <div style={{ color: COLORS.error }}>
                      <strong>错误:</strong> {activeTicket.assignment.error}
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
                    [待处理] {activeTicket.attention.question}
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
                  <div style={{ fontSize: '13px', fontWeight: 700, color: COLORS.text }}>
                    {t('triageTitle')}
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
                      {activeTicket.triage?.categoryLabel || getCategoryMeta(activeTicket.mandate.intent).label}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: COLORS.secondary, display: 'block', fontSize: '11px' }}>{t('triagePriority')}</span>
                    <span style={{ fontWeight: 600, color: COLORS.text }}>
                      {getPriorityMeta(activeTicket.priority).label}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: COLORS.secondary, display: 'block', fontSize: '11px' }}>{t('triageSchedule')}</span>
                    <span style={{ fontWeight: 600, color: COLORS.text }}>
                      {activeTicket.scheduleMode === 'nightly' ? '夜间低峰' : activeTicket.scheduleMode === 'scheduled' ? '定时执行' : '立即执行'}
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
                          已匹配: {rule}
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
                    {getSourceMeta(activeTicket.source).label} ({activeTicket.source})
                  </span>
                </div>
                <div>
                  <span style={{ color: COLORS.secondary }}>{t('priorityLabel')}: </span>
                  <span style={{ fontWeight: 500, color: COLORS.text }}>
                    {getPriorityMeta(activeTicket.priority).label}
                  </span>
                </div>
                <div>
                  <span style={{ color: COLORS.secondary }}>{t('scheduleLabel')}: </span>
                  <span style={{ fontWeight: 500, color: COLORS.text }}>
                    {activeTicket.scheduleMode === 'nightly' ? '夜间低峰' : activeTicket.scheduleMode === 'scheduled' ? '定时执行' : '立即执行'}
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
                    <span style={{ color: COLORS.success, fontWeight: 600 }}>分支: {activeTicket.workspace.worktree.branch}</span>
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
