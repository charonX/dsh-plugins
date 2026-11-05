/**
 * The Host facts the two extension areas need, in one narrow face.
 *
 * Components never receive a cordis context: the seat builds this face once and
 * passes it down, so the render tree stays testable and every cast against a
 * service shape lives in this file. Services are read dynamically because a
 * composition may omit any of them; a missing service degrades one surface
 * instead of failing the plugin.
 *
 * @module dsh-model-studio/client/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Preset } from '../shared/preset.ts'
import { presetConflict, presetOps, type PathOp } from './ops.ts'
import type { CompatSaveResult } from './CompatEditor.tsx'
import type { PresetApplyResult } from './PresetPanel.tsx'

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

/** The two settings faces this plugin writes through. */
interface ConfigFormLike {
  getSnapshot(): {
    readonly status: 'loading' | 'ready' | 'unavailable'
    readonly value: unknown
    readonly revision: number | undefined
    readonly writable: boolean
  }
  mutate(ops: readonly PathOp[], expectedRevision?: number): Promise<boolean>
  subscribe?(listener: () => void): () => void
}

/** What the page already knows about providers, as this plugin needs it. */
export interface DirectorySnapshot {
  /** Every route id the Models page knows: shipped catalog entries and stored profiles. */
  readonly routeIds: ReadonlySet<string>
  /** Namespace that owns the pi-ai provider profiles, when one is served. */
  readonly piAiNamespace: string | undefined
  /** Path from that namespace's root to a route, e.g. `['providers']`. */
  readonly routePrefix: readonly string[]
  /** Whether that namespace's document accepts writes. */
  readonly writable: boolean
}

/** One route's stored compatibility, as the editor sees it. */
export interface CompatSnapshot {
  /** Whether the namespace is served (its form values are readable). */
  readonly available: boolean
  /** Whether the document accepts writes. */
  readonly writable: boolean
  /** Stored compat object, when the user layer sets one. */
  readonly stored: unknown
  /** Revision the next write must be fenced with. */
  readonly revision: number | undefined
}

/** Host operations handed to the two surfaces. */
export interface HostFace {
  /** Read the provider directory (route ids and the pi-ai namespace). */
  readDirectory(): Promise<DirectorySnapshot>
  /** Write one preset as a new route. */
  applyPreset(preset: Preset): Promise<PresetApplyResult>
  /** Read one route's stored compatibility. */
  readCompat(namespace: string, routePath: readonly string[]): CompatSnapshot
  /** Write compatibility operations for one route. */
  writeCompat(namespace: string, ops: readonly PathOp[], revision: number | undefined): Promise<CompatSaveResult>
  /**
   * Observe one namespace's form, so a first load or a pushed document update
   * reaches the editor instead of leaving it disabled on a stale read.
   * @returns the disposer removing the listener.
   */
  watchCompat(namespace: string, listener: () => void): () => void
}

/** Root path pi-ai profiles live under. */
const DEFAULT_ROUTE_PREFIX: readonly string[] = ['providers']

/** Read one object field without trusting its shape. */
function field(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null ? (source as Record<string, unknown>)[key] : undefined
}

/**
 * Build the client face over the services this composition provides.
 * @param ctx - browser-side plugin context.
 * @returns the operations the surfaces call.
 */
export function createHostFace(ctx: Context): HostFace {
  const remote = (): { listConfigurableProviders?: () => Promise<RemoteAnswer<DirectoryRow[]>> } | undefined =>
    field(field(ctx, 'remote'), 'llm') as { listConfigurableProviders?: () => Promise<RemoteAnswer<DirectoryRow[]>> } | undefined

  const formFor = (namespace: string): ConfigFormLike | undefined => {
    const forms = field(ctx, 'configForms') as { get?: (ns: string) => ConfigFormLike } | undefined
    return forms?.get?.(namespace)
  }

  const readDirectory = async (): Promise<DirectorySnapshot> => {
    const answer = await remote()?.listConfigurableProviders?.()
    const rows = answer?.ok === true ? answer.value ?? [] : []
    const routeIds = new Set(rows.map(row => row.provider))
    // The pi-ai namespace is the one whose rows are addressed as
    // `providers.<route>`; hand-declared routes reveal it even when every
    // catalog route belongs to another adapter family.
    const owner = rows.find(row => (row.settingsPath ?? [])[0] === DEFAULT_ROUTE_PREFIX[0])
    const piAiNamespace = owner?.settingsNs
    const routePrefix = owner?.settingsPath === undefined || owner.settingsPath.length === 0
      ? DEFAULT_ROUTE_PREFIX
      : owner.settingsPath.slice(0, -1)
    const writable = piAiNamespace === undefined ? false : formFor(piAiNamespace)?.getSnapshot().writable === true
    return { routeIds, piAiNamespace, routePrefix, writable }
  }

  const applyPreset = async (preset: Preset): Promise<PresetApplyResult> => {
    const directory = await readDirectory()
    if (presetConflict(preset, directory.routeIds) !== undefined) return { kind: 'exists' }
    const namespace = directory.piAiNamespace
    if (namespace === undefined) return { kind: 'refused', message: 'no provider namespace is served' }
    const form = formFor(namespace)
    if (form === undefined) return { kind: 'refused', message: 'the settings form is unavailable' }
    const snapshot = form.getSnapshot()
    if (!snapshot.writable) return { kind: 'readonly' }
    if (snapshot.status !== 'ready') return { kind: 'refused', message: `settings are ${snapshot.status}` }
    const written = await form.mutate(
      presetOps(preset, [...directory.routePrefix, preset.id]),
      snapshot.revision,
    )
    return written ? { kind: 'written' } : { kind: 'refused', message: 'the settings write was refused' }
  }

  const readCompat = (namespace: string, routePath: readonly string[]): CompatSnapshot => {
    const form = formFor(namespace)
    if (form === undefined) return { available: false, writable: false, stored: undefined, revision: undefined }
    const snapshot = form.getSnapshot()
    let node: unknown = snapshot.value
    for (const segment of [...routePath, 'compat']) {
      node = field(node, segment)
    }
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      stored: node,
      revision: snapshot.revision,
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

  const watchCompat = (namespace: string, listener: () => void): (() => void) => {
    const form = formFor(namespace)
    return form?.subscribe?.(listener) ?? (() => {})
  }

  return { readDirectory, applyPreset, readCompat, writeCompat, watchCompat }
}
