/** Manager panel tab definitions, labels, and legacy localStorage cache migration. */

export const MANAGER_TABS = ['board', 'team', 'policy', 'monitor', 'settings'] as const

export type ManagerTab = (typeof MANAGER_TABS)[number]

export const TAB_STORAGE_KEY = 'dsh-manager.panel.tab'

export const MANAGER_TAB_LABELS: Record<
  ManagerTab,
  'board.panel' | 'team.panel' | 'policy.panel' | 'monitor.panel' | 'settings.panel'
> = {
  board: 'board.panel',
  team: 'team.panel',
  policy: 'policy.panel',
  monitor: 'monitor.panel',
  settings: 'settings.panel',
}

/** Map raw or legacy persisted tab identifiers onto the current 5-tab IA. */
export function resolveManagerTab(raw: string | null | undefined): ManagerTab {
  if (raw === 'steward' || raw === 'records') return 'monitor'
  if (raw !== undefined && raw !== null && (MANAGER_TABS as readonly string[]).includes(raw)) {
    return raw as ManagerTab
  }
  return 'board'
}

/** Read and migrate the persisted active tab; degrades safely to `'board'` on storage errors. */
export function loadManagerTab(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): ManagerTab {
  try {
    return resolveManagerTab(storage?.getItem(TAB_STORAGE_KEY))
  } catch {
    return 'board'
  }
}

/** Persist the active tab; ignores storage write failures so in-memory navigation continues. */
export function saveManagerTab(
  tab: ManagerTab,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(TAB_STORAGE_KEY, tab)
  } catch {
    // A failing store must not break tab selection; the session keeps it.
  }
}
