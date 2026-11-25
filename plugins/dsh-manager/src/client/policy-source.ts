/** The policy state: versioned decision records and external-write approval gates. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActionCategory } from '../approval/approval-policy.ts'
import type { PolicyEntryKind, PolicyRecord } from '../policy/policy-core.ts'
import type { PolicyUpdateInput } from '../policy/wire-types.ts'

/** Whole-page snapshot the policy source publishes. */
export interface PolicySnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** Versions newest first; version 0 in the array is active. */
  readonly policies?: readonly PolicyRecord[]
  readonly actionError?: string | undefined
  readonly busy?: boolean
}

/** Props injected through the policy slot. */
export interface PolicyInjected {
  readonly hooks: { readonly policy: HostObservable<PolicySnapshot> }
  readonly onPolicyAddEntry: (input: { readonly kind: PolicyEntryKind; readonly statement: string }) => Promise<PolicyRecord | undefined>
  readonly onPolicyRemoveEntry: (entryId: string) => Promise<PolicyRecord | undefined>
  readonly onPolicyToggleCategory: (category: ActionCategory) => Promise<PolicyRecord | undefined>
  readonly onPolicyRetry: () => void
}

function errorText(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown }
    if (typeof record.message === 'string' && record.message !== '') return record.message
    if (typeof record.code === 'string') return record.code
  }
  return String(error)
}

/**
 * Create the policy source: loads versioned policies lazily on subscribe and
 * mints new immutable versions on user updates.
 */
export function createPolicySource(deps: {
  list: () => Promise<{ ok: boolean; value?: { readonly policies: readonly PolicyRecord[] }; error?: unknown }>
  update: (input: PolicyUpdateInput) => Promise<{ ok: boolean; value?: { readonly policy: PolicyRecord }; error?: unknown }>
}): PolicyInjected {
  let snapshot: PolicySnapshot = { status: 'loading' }
  const listeners = new Set<() => void>()
  const publish = (next: PolicySnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let policies: readonly PolicyRecord[] | undefined
    try {
      const result = await deps.list()
      policies = result.ok ? result.value?.policies : undefined
    } catch {
      policies = undefined
    }
    if (policies === undefined) {
      publish({ status: 'error', ...(snapshot.policies === undefined ? {} : { policies: snapshot.policies }) })
      return
    }
    publish({ status: 'ready', policies })
  }
  const mutate = async (input: PolicyUpdateInput): Promise<PolicyRecord | undefined> => {
    publish({ ...snapshot, busy: true })
    try {
      const result = await deps.update(input)
      if (!result.ok || result.value === undefined) {
        publish({ ...snapshot, actionError: errorText(result.error) })
        return undefined
      }
      await read()
      publish({ ...snapshot, actionError: undefined })
      return result.value.policy
    } catch (error) {
      publish({ ...snapshot, actionError: errorText(error) })
      return undefined
    } finally {
      publish({ ...snapshot, busy: false })
    }
  }
  return {
    hooks: {
      policy: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) void read()
          return () => {
            listeners.delete(listener)
          }
        },
      },
    },
    onPolicyAddEntry: input => mutate({ addEntries: [input] }),
    onPolicyRemoveEntry: entryId => mutate({ removeEntryIds: [entryId] }),
    onPolicyToggleCategory: async (category) => {
      const current = snapshot.policies?.[0]
      if (current === undefined) return undefined
      const exists = current.approvalCategories.includes(category)
      const next = exists
        ? current.approvalCategories.filter(item => item !== category)
        : [...current.approvalCategories, category]
      return await mutate({ approvalCategories: next })
    },
    onPolicyRetry: () => { void read() },
  }
}
