/**
 * The Host facts the plugin's surfaces need, in one narrow face.
 *
 * Everything the pages render comes from the shared **settings describe
 * mirror**: it holds every served namespace's redacted value, its revision, and
 * whether the document accepts writes. That is the same source the official
 * Models page reads, so a row on our page is exactly what dispatch will use,
 * and it does not depend on a Remote round-trip per read.
 *
 * The provider directory (`llm/listConfigurableProviders`) is read only where
 * the page genuinely needs it: deciding whether a preset's route id already
 * exists. A failed directory read degrades that one check instead of blanking
 * the pages.
 *
 * Components never receive a cordis context: the seat builds this face once and
 * passes it down, so every cast against a service shape lives in this file.
 *
 * @module dsh-model-studio/client/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Preset } from '../shared/preset.ts'
import { modelRoutesOf, type ModelRouteView } from './model-view.ts'
import { presetConflict, presetOps, type PathOp } from './ops.ts'
import type { CompatSaveResult, PresetApplyResult } from './results.ts'

/** One served settings namespace, as the describe mirror holds it. */
export interface NamespaceView {
  readonly ns: string
  readonly value: unknown
  readonly revision: number
}

/** The mirror's held answer. */
interface DescribeView {
  readonly writable: boolean
  readonly namespaces: readonly NamespaceView[]
}

/** The settings mirror as this plugin consumes it. */
interface DescribeFace {
  getSnapshot(): { readonly status: 'idle' | 'loading' | 'ready'; readonly view: DescribeView | undefined }
  subscribe(listener: () => void): () => void
  ensure(): Promise<void>
}

/** One provider row the Models page joins from the directory. */
interface DirectoryRow {
  readonly provider: string
  readonly settingsNs: string
  readonly settingsPath?: readonly string[]
}

/** Answer envelope of one Remote read. */
interface RemoteAnswer<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly message: string }
}

/** The write face of one namespace form. */
interface ConfigFormLike {
  mutate(ops: readonly PathOp[], expectedRevision?: number): Promise<boolean>
}

/** The settings service as this plugin consumes it. */
interface ConfigFormsLike {
  describe?(): DescribeFace
  get?(ns: string): ConfigFormLike
}

/** What the preset panel needs from the provider directory. */
export interface DirectorySnapshot {
  /** Every route id the Models page knows: shipped catalog entries and stored profiles. */
  readonly routeIds: ReadonlySet<string>
  /** Namespace that owns the provider profiles, when one is served. */
  readonly piAiNamespace: string | undefined
  /** Path from that namespace's root to a route, e.g. `['providers']`. */
  readonly routePrefix: readonly string[]
  /** Whether that namespace's document accepts writes. */
  readonly writable: boolean
  /**
   * Whether the provider directory answered too, so route-id conflicts are
   * checked against shipped catalog routes as well as stored profiles.
   */
  readonly complete: boolean
}

/** The model page's view of the loaded profiles. */
export interface ModelPageSnapshot {
  /** Whether a provider namespace is served. */
  readonly available: boolean
  /** Whether the document accepts writes. */
  readonly writable: boolean
  /** Revision the next write must be fenced with. */
  readonly revision: number | undefined
  /** Namespace the routes belong to. */
  readonly namespace: string | undefined
  /** Loaded routes with their declared models. */
  readonly routes: readonly ModelRouteView[]
}

/** One route's stored compatibility, as the editors see it. */
export interface CompatSnapshot {
  /** Whether the namespace is served (its values are readable). */
  readonly available: boolean
  /** Whether the document accepts writes. */
  readonly writable: boolean
  /** Stored compat object, when the layer sets one. */
  readonly stored: unknown
  /** Revision the next write must be fenced with. */
  readonly revision: number | undefined
}

/** Host operations handed to the surfaces. */
export interface HostFace {
  /** Route ids and the provider namespace, for preset conflict checks. */
  readDirectory(): Promise<DirectorySnapshot>
  /** Write one preset as a new route. */
  applyPreset(preset: Preset): Promise<PresetApplyResult>
  /** Every loaded route with its models. */
  readModels(): Promise<ModelPageSnapshot>
  /** Read one route's stored compatibility. */
  readCompat(namespace: string, routePath: readonly string[]): Promise<CompatSnapshot>
  /** Write operations against one namespace. */
  writeCompat(namespace: string, ops: readonly PathOp[], revision: number | undefined): Promise<CompatSaveResult>
  /** Observe the settings mirror, so pages refresh on any pushed change. */
  watchSettings(listener: () => void): () => void
}

/** Namespace used when discovery fails; the shipped pi-ai entry id. */
const FALLBACK_NAMESPACE = 'llm-pi-ai'

/** Root path pi-ai profiles live under. */
const ROUTE_PREFIX: readonly string[] = ['providers']

/** Read one object field without trusting its shape. */
function field(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null ? (source as Record<string, unknown>)[key] : undefined
}

/**
 * Read a service through the context's inject-free accessor.
 *
 * Property access (`ctx.someService`) is guarded by the cordis inject rules, so
 * a plugin that keeps its dependency list minimal reads services this way and
 * degrades per surface when one is missing.
 * @param ctx - browser-side plugin context.
 * @param name - service name.
 * @returns the service, or undefined when this composition does not provide it.
 */
function service<T>(ctx: Context, name: string): T | undefined {
  const read = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof read === 'function') {
    try {
      const value = read.call(ctx, name)
      if (value !== undefined) return value as T
    } catch {
      // Inactive or missing service: fall through to the property read.
    }
  }
  try {
    return (ctx as unknown as Record<string, T | undefined>)[name]
  } catch {
    // Property access without a declared inject throws by design.
    return undefined
  }
}

/**
 * Pick the namespace that owns provider profiles from a describe view.
 * A pi-ai entry is the one whose value carries a `providers` dictionary; no
 * other settings namespace has that shape.
 * @param namespaces - served namespaces.
 * @returns the owning namespace, when one is present and non-empty.
 */
export function providerNamespaceOf(namespaces: readonly NamespaceView[]): string | undefined {
  return namespaces.find(entry => typeof field(entry.value, 'providers') === 'object')?.ns
}

/**
 * Build the client face over the services this composition provides.
 * @param ctx - browser-side plugin context.
 * @returns the operations the surfaces call.
 */
export function createHostFace(ctx: Context): HostFace {
  const forms = (): ConfigFormsLike | undefined => service<ConfigFormsLike>(ctx, 'configForms')

  const describe = (): DescribeFace | undefined => forms()?.describe?.()

  const formFor = (namespace: string): ConfigFormLike | undefined => forms()?.get?.(namespace)

  /** The mirror's held view, awaiting the first read when nothing is held yet. */
  const view = async (): Promise<DescribeView | undefined> => {
    const face = describe()
    if (face === undefined) return undefined
    const held = face.getSnapshot()
    if (held.view !== undefined) return held.view
    try {
      await face.ensure()
    } catch {
      return undefined
    }
    return face.getSnapshot().view
  }

  const namespaceViewOf = (held: DescribeView | undefined, namespace: string | undefined): NamespaceView | undefined =>
    namespace === undefined ? undefined : held?.namespaces.find(entry => entry.ns === namespace)

  const readDirectory = async (): Promise<DirectorySnapshot> => {
    const held = await view()
    const stored = field(namespaceViewOf(held, providerNamespaceOf(held?.namespaces ?? []))?.value, 'providers')
    const routeIds = new Set<string>(typeof stored === 'object' && stored !== null ? Object.keys(stored) : [])
    let piAiNamespace = providerNamespaceOf(held?.namespaces ?? [])
    let complete = false
    const remote = service<{ llm?: { listConfigurableProviders?: () => Promise<RemoteAnswer<DirectoryRow[]>> } }>(ctx, 'remote')?.llm
    try {
      const answer = await remote?.listConfigurableProviders?.()
      if (answer?.ok === true) {
        const rows = answer.value ?? []
        for (const row of rows) routeIds.add(row.provider)
        piAiNamespace ??= rows.find(row => (row.settingsPath ?? [])[0] === ROUTE_PREFIX[0])?.settingsNs
        complete = true
      }
    } catch (failure) {
      // The directory only feeds the preset conflict check; a failed read must
      // not blank the page, but the caller should stop offering writes that
      // could overwrite a shipped route.
      console.warn('model-studio: provider directory read failed', failure)
    }
    return {
      routeIds,
      piAiNamespace,
      routePrefix: ROUTE_PREFIX,
      writable: held?.writable === true,
      complete,
    }
  }

  const applyPreset = async (preset: Preset): Promise<PresetApplyResult> => {
    const directory = await readDirectory()
    if (presetConflict(preset, directory.routeIds) !== undefined) return { kind: 'exists' }
    const namespace = directory.piAiNamespace
    if (namespace === undefined) return { kind: 'refused', message: 'no provider namespace is served' }
    const form = formFor(namespace)
    if (form === undefined) return { kind: 'refused', message: 'the settings form is unavailable' }
    if (!directory.writable) return { kind: 'readonly' }
    const written = await form.mutate(presetOps(preset, [...directory.routePrefix, preset.id]), undefined)
    return written ? { kind: 'written' } : { kind: 'refused', message: 'the settings write was refused' }
  }

  const readModels = async (): Promise<ModelPageSnapshot> => {
    const held = await view()
    const namespace = providerNamespaceOf(held?.namespaces ?? [])
    const entry = namespaceViewOf(held, namespace)
    return {
      available: entry !== undefined,
      writable: held?.writable === true,
      revision: entry?.revision,
      namespace,
      routes: modelRoutesOf(entry?.value, ROUTE_PREFIX),
    }
  }

  const readCompat = async (namespace: string, routePath: readonly string[]): Promise<CompatSnapshot> => {
    const held = await view()
    const entry = namespaceViewOf(held, namespace)
    if (entry === undefined) return { available: false, writable: false, stored: undefined, revision: undefined }
    let node: unknown = entry.value
    for (const segment of [...routePath, 'compat']) node = field(node, segment)
    return {
      available: true,
      writable: held?.writable === true,
      stored: node,
      revision: entry.revision,
    }
  }

  const writeCompat = async (
    namespace: string,
    ops: readonly PathOp[],
    revision: number | undefined,
  ): Promise<CompatSaveResult> => {
    const form = formFor(namespace)
    if (form === undefined) return { kind: 'refused', message: 'the settings form is unavailable' }
    const written = await form.mutate(ops, revision)
    return written ? { kind: 'saved' } : { kind: 'refused', message: 'the settings write was refused' }
  }

  const watchSettings = (listener: () => void): (() => void) => describe()?.subscribe(listener) ?? (() => {})

  return { readDirectory, applyPreset, readModels, readCompat, writeCompat, watchSettings }
}
