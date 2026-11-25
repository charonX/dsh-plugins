/**
 * Pure client-side external task polling store shared by `ExternalTasksUi`
 * and Node unit tests without bundling CSS modules or React JSX.
 */
import type { ExternalTaskState, SessionAgentState } from '../types.ts'

const POLL_INTERVAL_MS = 1_000
const EMPTY_TASKS: readonly ExternalTaskState[] = []

export interface ExternalTasksStore {
  subscribe(sessionId: string, listener: () => void): () => void
  getSnapshot(sessionId: string): readonly ExternalTaskState[]
  syncRunning(sessionId: string, running: boolean): void
}

export function createExternalTasksStore(
  fetchSessionState: (sessionId: string) => Promise<SessionAgentState>,
): ExternalTasksStore {
  const tasksBySession = new Map<string, readonly ExternalTaskState[]>()
  const listenersBySession = new Map<string, Set<() => void>>()
  const timersBySession = new Map<string, ReturnType<typeof setInterval>>()
  const runningBySession = new Map<string, boolean>()

  const notify = (sessionId: string): void => {
    const listeners = listenersBySession.get(sessionId)
    if (listeners === undefined) return
    for (const listener of listeners) listener()
  }

  const stopPolling = (sessionId: string): void => {
    const timer = timersBySession.get(sessionId)
    if (timer !== undefined) {
      clearInterval(timer)
      timersBySession.delete(sessionId)
    }
  }

  const hasRunningTasks = (sessionId: string): boolean => {
    const tasks = tasksBySession.get(sessionId)
    return tasks !== undefined && tasks.some(task => task.status === 'running')
  }

  const pollOnce = async (sessionId: string): Promise<void> => {
    try {
      const state = await fetchSessionState(sessionId)
      const next = state.activeTasks ?? EMPTY_TASKS
      const prev = tasksBySession.get(sessionId) ?? EMPTY_TASKS
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        tasksBySession.set(sessionId, next)
        notify(sessionId)
      }
      const hasRunning = next.some(task => task.status === 'running')
      if (!hasRunning && runningBySession.get(sessionId) !== true) {
        stopPolling(sessionId)
        if (next.length > 0) {
          tasksBySession.set(sessionId, EMPTY_TASKS)
          notify(sessionId)
        }
      }
    } catch {
      // Ignore transient poll errors while turn runs.
    }
  }

  const ensurePolling = (sessionId: string, forceCheckOnce = false): void => {
    const isRunning = runningBySession.get(sessionId) === true
    const hasBg = hasRunningTasks(sessionId)
    const hasListeners = (listenersBySession.get(sessionId)?.size ?? 0) > 0
    if (!hasListeners) {
      stopPolling(sessionId)
      return
    }
    if (!isRunning && !hasBg) {
      stopPolling(sessionId)
      if (forceCheckOnce) {
        void pollOnce(sessionId).then(() => {
          if ((listenersBySession.get(sessionId)?.size ?? 0) > 0 && hasRunningTasks(sessionId) && !timersBySession.has(sessionId)) {
            timersBySession.set(sessionId, setInterval(() => {
              void pollOnce(sessionId)
            }, POLL_INTERVAL_MS))
          }
        })
      }
      return
    }
    if (!timersBySession.has(sessionId)) {
      void pollOnce(sessionId)
      timersBySession.set(sessionId, setInterval(() => {
        void pollOnce(sessionId)
      }, POLL_INTERVAL_MS))
    }
  }

  return {
    subscribe(sessionId, listener) {
      let set = listenersBySession.get(sessionId)
      if (set === undefined) {
        set = new Set()
        listenersBySession.set(sessionId, set)
      }
      set.add(listener)
      ensurePolling(sessionId, true)
      return () => {
        set.delete(listener)
        if (set.size === 0) {
          listenersBySession.delete(sessionId)
          stopPolling(sessionId)
        }
      }
    },
    getSnapshot(sessionId) {
      return tasksBySession.get(sessionId) ?? EMPTY_TASKS
    },
    syncRunning(sessionId, running) {
      const prev = runningBySession.get(sessionId) === true
      if (prev === running) return
      runningBySession.set(sessionId, running)
      if (!running) {
        // Re-check once after turn end: background CLI tasks (e.g. `agy`) may still be running.
        ensurePolling(sessionId, true)
        return
      }
      ensurePolling(sessionId)
    },
  }
}
