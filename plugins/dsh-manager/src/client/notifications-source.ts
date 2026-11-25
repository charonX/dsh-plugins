/** The GUI notification feed: polled rows, the unseen badge count, and the seen mark. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { NotificationView } from '../notifications/notification-core.ts'

/** The localStorage key the seen-notification ids persist under. */
const SEEN_STORAGE_KEY = 'dsh-manager.notifications.seen'

/** The notification feed exposed to the board page and its nav icon. */
export interface NotificationsSnapshot {
  /** Every notification the host GUI feed holds, newest first. */
  readonly notifications: readonly NotificationView[]
  /** How many notifications the user has not seen yet; the badge reads this. */
  readonly unseenCount: number
}

/** Remote read scoped by the registering entry. */
export interface NotificationsDependencies {
  /** Read the feed; the failed read keeps the last one. */
  readonly list: () => Promise<{ readonly ok: boolean; readonly value?: { readonly notifications: readonly NotificationView[] } }>
  /** Poll cadence in millis; 0 disables. */
  readonly pollMs?: number
}

/** Props injected through the board and nav-icon slots. */
export interface NotificationsInjected {
  readonly hooks: { readonly notifications: HostObservable<NotificationsSnapshot> }
  /** Mark every current notification seen (the badge clears). */
  readonly onMarkSeen: () => void
}

/** Read the persisted seen ids; a corrupt record reads as none. */
function loadSeen(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_STORAGE_KEY)
    if (raw === null || raw === undefined || raw === '') return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

/**
 * Create the GUI notification feed source: the host list polls on a cadence,
 * unseen ids persist in localStorage, and marking seen publishes a fresh
 * snapshot so the badge clears without waiting for the next poll.
 * @param deps - the remote read and the poll cadence.
 */
export function createNotificationsSource(deps: NotificationsDependencies): NotificationsInjected {
  let snapshot: NotificationsSnapshot = { notifications: [], unseenCount: 0 }
  const seen = loadSeen()
  const listeners = new Set<() => void>()
  let disposers: readonly (() => void)[] = []
  const publish = (next: NotificationsSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let notifications: readonly NotificationView[] = []
    try {
      const result = await deps.list()
      notifications = result.ok ? result.value?.notifications ?? [] : snapshot.notifications ?? []
    } catch {
      notifications = snapshot.notifications ?? []
    }
    const unseen = notifications.filter(notification => !seen.has(notification.id)).length
    publish({ notifications, unseenCount: unseen })
  }
  const subscribe = (): void => {
    const handles: (() => void)[] = []
    if (deps.pollMs !== undefined && deps.pollMs > 0) {
      const timer = setInterval(() => { void read() }, deps.pollMs)
      handles.push(() => { clearInterval(timer) })
    }
    disposers = handles
    void read()
  }
  return {
    hooks: {
      notifications: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) subscribe()
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            for (const dispose of disposers) dispose()
            disposers = []
          }
        },
      },
    },
    onMarkSeen() {
      for (const notification of snapshot.notifications ?? []) seen.add(notification.id)
      try {
        globalThis.localStorage?.setItem(SEEN_STORAGE_KEY, JSON.stringify([...seen]))
      } catch {
        // A failing store must not break the feed; the session keeps it.
      }
      publish({
        notifications: snapshot.notifications,
        unseenCount: 0,
      })
    },
  }
}
