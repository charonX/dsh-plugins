/**
 * Session Panel Environment row displaying the current Git branch, linked
 * worktree posture (including worktrees created by external CLI skills), and
 * active worktrees in the repository.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  HoverCard,
  IconBranchOutlineRegular,
  IconRefreshOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-working-directory/types'
import type { WorkspaceGitStatus } from '../types.ts'
import type { ExternalAgentsLocaleKey } from './locales.ts'

export interface WorktreeRowInjected {
  readonly fetchWorkspaceStatus: (sessionId: string) => Promise<WorkspaceGitStatus>
}

export type WorktreeEnvironmentRowProps =
  PropsRuntime<'conversation.session.panel.environment.row'>
  & PropsRenderFactories
  & WorktreeRowInjected
  & { readonly t: (key: ExternalAgentsLocaleKey, params?: Record<string, unknown>) => string }

function shortFolderLabel(fullPath: string | undefined): string {
  if (fullPath === undefined || fullPath === '') return ''
  const parts = fullPath.replace(/[/\\]+$/u, '').split(/[/\\]/u)
  return parts[parts.length - 1] ?? fullPath
}

export function WorktreeEnvironmentRow({
  sessionId,
  useProjection,
  useSessionStatus,
  renderFactorySlot,
  fetchWorkspaceStatus,
  t,
}: WorktreeEnvironmentRowProps) {
  const workingDirectory = useProjection('workingDirectory')
  const running = useSessionStatus(snapshot => snapshot.get(sessionId)?.running ?? false)
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const prevRunningRef = useRef(running)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadStatus = useCallback(async () => {
    setRefreshing(true)
    try {
      const next = await fetchWorkspaceStatus(String(sessionId))
      if (mountedRef.current) setStatus(next)
    } catch {
      // Keep previous reading if transient probe fails.
    } finally {
      if (mountedRef.current) setRefreshing(false)
    }
  }, [fetchWorkspaceStatus, sessionId])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus, workingDirectory])

  // Refresh after a turn finishes so worktrees created by an external skill/CLI appear immediately.
  useEffect(() => {
    if (prevRunningRef.current && !running) {
      void loadStatus()
    }
    prevRunningRef.current = running
  }, [running, loadStatus])

  if (status === null || !status.isGitRepo) return null

  const branchLabel = status.branch ?? (status.shortHead ? `${t('worktreeDetached')} (${status.shortHead})` : t('worktreeDetached'))
  const worktreeCount = status.worktrees.length
  const detailParts: string[] = []
  if (status.isWorktree) {
    detailParts.push(t('worktreeLinked'))
  } else if (worktreeCount > 1) {
    detailParts.push(t('worktreeTotalCount', { count: worktreeCount }))
  }
  if (status.dirtyCount > 0) {
    detailParts.push(t('worktreeDirtyCount', { count: status.dirtyCount }))
  } else if (detailParts.length === 0) {
    detailParts.push(t('worktreeClean'))
  }

  const lines: string[] = []
  if (status.repoRoot !== undefined) {
    lines.push(status.repoRoot)
  }
  if (status.isWorktree && status.mainRepoRoot !== undefined) {
    lines.push(`${t('worktreeMainRepo')}: ${shortFolderLabel(status.mainRepoRoot)} (${status.mainRepoRoot})`)
  }
  for (const wt of status.worktrees.slice(0, 4)) {
    const marker = wt.isCurrent ? '* ' : '  '
    const wtBranch = wt.branch ?? wt.head ?? 'HEAD'
    lines.push(`${marker}${wtBranch} — ${shortFolderLabel(wt.path)}`)
  }

  const cardDetails = renderFactorySlot('conversation.session.panel.details', {
    title: branchLabel,
    lines: lines.slice(0, 6),
    status: {
      state: status.dirtyCount > 0 ? 'warning' : 'done',
      label: status.isWorktree ? t('worktreeLinked') : t('worktreeMainRepo'),
    },
  })

  const trailingText = status.isWorktree
    ? t('worktreeBadge')
    : status.dirtyCount > 0
      ? String(status.dirtyCount)
      : worktreeCount > 1
        ? `${worktreeCount}`
        : undefined

  const row = (
    <div data-session-panel-row="" data-external-worktree-row="">
      <span data-row-part="body">
        <span data-row-part="icon" aria-hidden="true">
          <IconBranchOutlineRegular size={16} />
        </span>
        <span data-row-part="lines">
          <span data-row-part="content">{branchLabel}</span>
          <span data-row-part="detail">{detailParts.join(' · ')}</span>
        </span>
        {trailingText !== undefined && (
          <span data-row-part="trailing">{trailingText}</span>
        )}
      </span>
      <span data-row-part="menu">
        <Tooltip label={t('worktreeRefresh')} side="left" delayMs={400}>
          <button
            type="button"
            aria-label={t('worktreeRefresh')}
            disabled={refreshing}
            onClick={() => { void loadStatus() }}
          >
            <IconRefreshOutlineRegular size={14} />
          </button>
        </Tooltip>
      </span>
    </div>
  )

  return <HoverCard anchor={row} content={cardDetails} grouped />
}
