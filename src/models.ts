/**
 * Model catalog reads and selection resolution.
 *
 * The catalog is the Host's own provider directory: this plugin never adds or
 * edits providers, it only lists what the Host already serves and says which
 * routes can turn thinking off.
 *
 * @module dsh-immersive-translate/models
 */

import type { LlmModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type {
  ModelView,
  ProviderGroupView,
  ResolutionView,
  SelectionSource,
  SelectionView,
  TranslatePrefs,
} from './shared/api.js'

/**
 * List every advertised provider and its models.
 *
 * Only what the selector draws is read: the catalog is two adapter calls per
 * provider (`listProviders`, `listModels`). The reasoning metadata is deliberately
 * not resolved here - selection is the engine's business (`preferNoThinking`
 * reads it at call time) and resolving it per model made `/api/state` wait on a
 * round trip for every model the reader would never pick.
 * @param llm - Host LLM runtime.
 * @param signal - optional cancellation for adapter-owned catalog lookups.
 * @returns provider groups in registration order, each with at least one model.
 */
export async function listCatalog(llm: LlmRuntime, signal?: AbortSignal): Promise<ProviderGroupView[]> {
  const groups: ProviderGroupView[] = []
  for (const provider of llm.listProviders()) {
    signal?.throwIfAborted()
    let models: LlmModelInfo[]
    try {
      models = await llm.listModels(provider.id)
    } catch {
      continue
    }
    const rows: ModelView[] = []
    for (const model of models) {
      signal?.throwIfAborted()
      rows.push({ id: model.id, name: model.name })
    }
    if (rows.length > 0) groups.push({ id: provider.id, name: provider.name, models: rows })
  }
  return groups
}

/**
 * Pick the effective route from the three inputs the Host can supply.
 *
 * Precedence: an explicit override wins, then the Session's own recorded
 * selection, then the Host default for sessions without one.
 * @param override - preferences naming a route explicitly, when the reader
 *   turned following off.
 * @param sessionSelection - the bound Session's recorded selection, if any.
 * @param defaultSelection - the Host default selection, if any.
 * @returns the winning selection together with the rule that produced it.
 */
export function resolveSelection(
  override: SelectionView | undefined,
  sessionSelection: SelectionView | undefined,
  defaultSelection: SelectionView | undefined,
): ResolutionView {
  const candidates: readonly [SelectionSource, SelectionView | undefined][] = [
    ['override', override],
    ['session', sessionSelection],
    ['default', defaultSelection],
  ]
  for (const [source, selection] of candidates) {
    if (selection !== undefined) return { source, selection }
  }
  return { source: null, selection: null }
}

/**
 * Read the route the reader pinned, when following is off.
 * @param prefs - stored preferences.
 * @returns the pinned route, or undefined when following the Host default.
 */
export function overrideOf(prefs: TranslatePrefs): SelectionView | undefined {
  if (prefs.followDefaultModel) return undefined
  if (prefs.provider === undefined || prefs.model === undefined) return undefined
  return { provider: prefs.provider, model: prefs.model }
}

/**
 * Narrow an arbitrary projection value into a selection.
 * @param value - `modelSelection` projection value read from a Session.
 * @returns the newest recorded selection, or undefined.
 */
export function selectionOfProjection(value: unknown): SelectionView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as Record<string, unknown>
  for (const key of ['next', 'lastUsed'] as const) {
    const candidate = state[key]
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    if (typeof record.provider === 'string' && typeof record.model === 'string') {
      return { provider: record.provider, model: record.model }
    }
  }
  return undefined
}
