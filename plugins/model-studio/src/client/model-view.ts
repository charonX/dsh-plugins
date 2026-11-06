/**
 * The model page's view of the loaded provider profiles.
 *
 * The page reads the same settings document the official Models card edits, so
 * it shows exactly what the harness will dispatch: every stored route and the
 * models declared under it, including entries that came from a preset, from the
 * official card, or from a patch layer.
 *
 * @module dsh-model-studio/client/model-view
 */

/** One model entry as the page renders it. */
export interface ModelEntryView {
  /** Position in the route's `models[]`; the write path addresses it. */
  readonly index: number
  /** Exact model id. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Path from the namespace root to this model entry. */
  readonly path: readonly string[]
  /** Context window in tokens, when declared. */
  readonly contextWindow?: number
  /** Output cap in tokens, when declared. */
  readonly maxTokens?: number
  /** Declared reasoning levels, `off` first, when the model reasons. */
  readonly levels?: readonly string[]
  /** Stored model-level compat block, when one exists. */
  readonly storedCompat?: unknown
}

/** One route with its models. */
export interface ModelRouteView {
  /** Route id (the `providers` dictionary key). */
  readonly routeId: string
  /** Display name. */
  readonly name: string
  /** Path from the namespace root to this route. */
  readonly path: readonly string[]
  /** Endpoint, when declared. */
  readonly baseURL?: string
  /** Stored gateway-level compat block, when one exists. */
  readonly storedCompat?: unknown
  /** Declared models in configuration order. */
  readonly models: readonly ModelEntryView[]
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one model entry.
 * @param value - stored entry.
 * @param index - position in the array.
 * @param path - absolute path to the entry.
 * @returns the view, or undefined when the entry has no usable id.
 */
function modelEntryOf(value: unknown, index: number, path: readonly string[]): ModelEntryView | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value['id'] === 'string' ? value['id'] : undefined
  if (id === undefined || id.length === 0) return undefined
  const efforts = value['reasoningEfforts']
  const levels = isRecord(efforts) ? Object.keys(efforts) : undefined
  const contextWindow = value['contextWindow']
  const maxTokens = value['maxTokens']
  return {
    index,
    id,
    name: typeof value['name'] === 'string' && value['name'].length > 0 ? value['name'] : id,
    path,
    ...typeof contextWindow === 'number' ? { contextWindow } : {},
    ...typeof maxTokens === 'number' ? { maxTokens } : {},
    ...levels === undefined ? {} : { levels },
    ...value['compat'] === undefined ? {} : { storedCompat: value['compat'] },
  }
}

/**
 * Build the page's routes from one settings value.
 * A route with no declared model is omitted: the page edits model entries, and
 * an empty array has nothing to edit (the official card owns declaring models).
 * @param value - the pi-ai namespace value.
 * @param routePrefix - path from the namespace root to a route, e.g. `['providers']`.
 * @returns routes sorted by id, each with its models in configuration order.
 */
export function modelRoutesOf(value: unknown, routePrefix: readonly string[]): ModelRouteView[] {
  const providers = isRecord(value) ? value['providers'] : undefined
  if (!isRecord(providers)) return []
  const routes: ModelRouteView[] = []
  for (const [routeId, profile] of Object.entries(providers)) {
    if (!isRecord(profile)) continue
    const models = Array.isArray(profile['models']) ? profile['models'] : []
    const entries = models
      .map((model, index) => modelEntryOf(model, index, [...routePrefix, routeId, 'models', String(index)]))
      .filter((entry): entry is ModelEntryView => entry !== undefined)
    if (entries.length === 0) continue
    routes.push({
      routeId,
      name: typeof profile['displayName'] === 'string' && profile['displayName'].length > 0
        ? profile['displayName']
        : routeId,
      path: [...routePrefix, routeId],
      ...typeof profile['baseURL'] === 'string' ? { baseURL: profile['baseURL'] } : {},
      ...profile['compat'] === undefined ? {} : { storedCompat: profile['compat'] },
      models: entries,
    })
  }
  return routes.sort((left, right) => left.routeId.localeCompare(right.routeId))
}
