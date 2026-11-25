/**
 * Hot-reload sync source for team/pipeline/route YAML config: polls revision
 * & validation status while subscribed, triggers list refreshes whenever the
 * host revision changes or the connection resets, and surfaces `lastError`
 * banners in the Team UI.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamConfigStatusView } from '../team-config/team-config-core.ts'

/** Snapshot published to TeamPage for config path & validation error visibility. */
export interface TeamConfigSnapshot {
  readonly status: 'idle' | 'ready'
  readonly configStatus?: TeamConfigStatusView
  readonly busy?: boolean
}

/** Props injected into the manager panel for team-config hot-reload status. */
export interface TeamConfigInjected {
  readonly hooks: { readonly teamConfig: HostObservable<TeamConfigSnapshot> }
  readonly onTeamConfigReload: () => Promise<void>
}

export interface TeamConfigSourceDependencies {
  readonly readStatus?: () => Promise<{ ok: boolean; value?: TeamConfigStatusView }>
  readonly reload?: () => Promise<{ ok: boolean; value?: TeamConfigStatusView }>
  readonly subscribeReset?: (listener: () => void) => () => void
  readonly onInvalidate?: () => void
  readonly pollMs?: number
}

/**
 * Create the team-config status source and change detector.
 * @param deps - status/reload remote calls, reset hook, and invalidate fan-out.
 * @returns injected observable/action face plus an internal `bumpRevision` hook.
 */
export function createTeamConfigSource(deps: TeamConfigSourceDependencies): TeamConfigInjected {
  let snapshot: TeamConfigSnapshot = { status: 'idle' }
  let lastRevision: number | undefined
  let disposers: readonly (() => void)[] = []
  let inFlight = false
  const listeners = new Set<() => void>()

  const publish = (next: TeamConfigSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const checkStatus = async (forceInvalidate = false): Promise<void> => {
    if (deps.readStatus === undefined || inFlight) {
      if (forceInvalidate) deps.onInvalidate?.()
      return
    }
    inFlight = true
    try {
      const result = await deps.readStatus()
      if (!result.ok || result.value === undefined) return
      const nextStatus = result.value
      const changed = lastRevision !== undefined && nextStatus.revision !== lastRevision
      lastRevision = nextStatus.revision
      publish({ status: 'ready', configStatus: nextStatus, ...(snapshot.busy === undefined ? {} : { busy: snapshot.busy }) })
      if (changed || forceInvalidate) deps.onInvalidate?.()
    } catch {
      // Transient transport failure leaves the previous status visible.
    } finally {
      inFlight = false
    }
  }

  return {
    hooks: {
      teamConfig: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            const handles: (() => void)[] = []
            if (deps.subscribeReset !== undefined) {
              handles.push(deps.subscribeReset(() => { void checkStatus(true) }))
            }
            if (deps.pollMs !== undefined && deps.pollMs > 0 && deps.readStatus !== undefined) {
              const timer = setInterval(() => { void checkStatus(false) }, deps.pollMs)
              handles.push(() => { clearInterval(timer) })
            }
            disposers = handles
            void checkStatus(false)
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            for (const dispose of disposers) dispose()
            disposers = []
          }
        },
      },
    },
    async onTeamConfigReload() {
      if (deps.reload === undefined) return
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.reload()
        if (result.ok && result.value !== undefined) {
          lastRevision = result.value.revision
          publish({ status: 'ready', configStatus: result.value, busy: false })
        } else {
          publish({ ...snapshot, busy: false })
        }
        deps.onInvalidate?.()
      } catch {
        publish({ ...snapshot, busy: false })
      }
    },
  }
}
