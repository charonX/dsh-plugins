/**
 * Live external CLI subagent / background task status store and DSH UI
 * projections (`conversation.input.dock`, Session Panel section, and panel indicator).
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  HoverCard,
  IconUsersOutlineRegular,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExternalTaskState } from '../types.ts'
import type { ExternalAgentsLocaleKey } from './locales.ts'
import { createExternalTasksStore, type ExternalTasksStore } from './external-tasks-store.ts'
import css from './ExternalTasksUi.module.css'

export { createExternalTasksStore, type ExternalTasksStore } from './external-tasks-store.ts'

function useExternalTasks(
  store: ExternalTasksStore,
  sessionId: string,
  running: boolean,
): readonly ExternalTaskState[] {
  useEffect(() => {
    store.syncRunning(sessionId, running)
  }, [store, sessionId, running])

  return useSyncExternalStore(
    listener => store.subscribe(sessionId, listener),
    () => store.getSnapshot(sessionId),
  )
}

function formatElapsedSeconds(startedAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1_000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${secs % 60}s`
}

function dotStateForTask(status: ExternalTaskState['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'stopped': return 'idle'
  }
}

type TranslateFn = (key: ExternalAgentsLocaleKey, params?: Record<string, unknown>) => string

export interface ExternalTasksInjected {
  readonly store: ExternalTasksStore
}

export function ExternalTasksInputDock({
  sessionId,
  useSessionStatus,
  store,
  t,
}: PropsRuntime<'conversation.input.dock'> & ExternalTasksInjected & { readonly t: TranslateFn }) {
  const running = useSessionStatus(snapshot => snapshot.get(sessionId)?.running ?? false)
  const tasks = useExternalTasks(store, String(sessionId), running)
  const active = tasks.filter(task => task.status === 'running')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (active.length === 0) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [active.length])

  if (active.length === 0) return null

  return (
    <div className={css.dockBar} data-external-tasks-dock="">
      <div className={css.dockHeader}>
        <span className={css.dockLead} aria-hidden="true">
          <StateDot state="ongoing" size={14} />
        </span>
        <span>{t('tasksDockTitle')}</span>
        <span className={css.dockHeaderMeta}>{t('tasksRunningBadge', { count: active.length })}</span>
      </div>
      <div className={css.taskList}>
        {active.slice(0, 4).map((task) => {
          const desc = task.summary || task.description || task.label
          return (
            <div key={task.taskId} className={css.taskItem}>
              <span className={css.taskLabel}>{task.label}</span>
              <span className={css.taskDesc}>{desc}</span>
              {task.lastToolName !== undefined && (
                <span className={css.taskTool}>{t('tasksLastTool', { name: task.lastToolName })}</span>
              )}
              <span className={css.taskDuration}>{formatElapsedSeconds(task.startedAt, now)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ExternalTasksPanelSection({
  sessionId,
  useSessionStatus,
  renderFactorySlot,
  store,
  t,
}: PropsRuntime<'conversation.session.panel.section'> & PropsRenderFactories & ExternalTasksInjected & { readonly t: TranslateFn }) {
  const running = useSessionStatus(snapshot => snapshot.get(sessionId)?.running ?? false)
  const tasks = useExternalTasks(store, String(sessionId), running)
  const [now, setNow] = useState(() => Date.now())

  const hasRunning = tasks.some(task => task.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [hasRunning])

  if (tasks.length === 0) return null

  const statusText = (status: ExternalTaskState['status']): string => {
    switch (status) {
      case 'running': return t('tasksStatusRunning')
      case 'completed': return t('tasksStatusCompleted')
      case 'failed': return t('tasksStatusFailed')
      case 'stopped': return t('tasksStatusStopped')
    }
  }

  return (
    <div className={css.panelSection} data-external-tasks-section="">
      {tasks.map((task) => {
        const title = task.description || task.label
        const detail = task.lastToolName !== undefined
          ? t('tasksLastTool', { name: task.lastToolName })
          : task.summary
        const detailsContent = renderFactorySlot('conversation.session.panel.details', {
          title,
          lines: [
            task.label,
            ...(task.summary ? [task.summary] : []),
          ],
          status: {
            state: dotStateForTask(task.status),
            label: statusText(task.status),
          },
          facts: [
            { kind: 'duration', label: formatElapsedSeconds(task.startedAt, task.status === 'running' ? now : task.updatedAt) },
            ...(task.totalTokens !== undefined ? [{ kind: 'tokens' as const, label: `${task.totalTokens} tok` }] : []),
          ],
        })

        const row = (
          <div data-session-panel-row="">
            <span data-row-part="body">
              <span data-row-part="icon" aria-hidden="true">
                {task.status === 'running'
                  ? <StateDot state="ongoing" size={14} />
                  : <IconUsersOutlineRegular size={16} />}
              </span>
              <span data-row-part="lines">
                <span data-row-part="content">{title}</span>
                {detail !== undefined && <span data-row-part="detail">{detail}</span>}
              </span>
              <span data-row-part="trailing">
                {formatElapsedSeconds(task.startedAt, task.status === 'running' ? now : task.updatedAt)}
              </span>
            </span>
          </div>
        )

        return <HoverCard key={task.taskId} anchor={row} content={detailsContent} grouped />
      })}
    </div>
  )
}

export function ExternalTasksPanelIndicator({
  sessionId,
  panelShown,
  useSessionStatus,
  store,
  t,
}: PropsRuntime<'conversation.session.panel.indicator'> & ExternalTasksInjected & { readonly t: TranslateFn }) {
  const running = useSessionStatus(snapshot => snapshot.get(sessionId)?.running ?? false)
  const tasks = useExternalTasks(store, String(sessionId), running)
  const activeCount = tasks.filter(task => task.status === 'running').length
  if (panelShown || activeCount === 0) return null
  return (
    <span className={css.indicatorDot} data-external-tasks-running="">
      <span className={css.visuallyHidden}>{t('tasksIndicatorRunning', { count: activeCount })}</span>
    </span>
  )
}
