/**
 * Browser half: two extension areas inside the official Models page.
 *
 * `settings.models.footer` (list) hosts the preset panel once. The provider
 * card seat is keyed by a settings namespace, not by this plugin, so the keys
 * are resolved from the served provider directory at startup and the default
 * pi-ai namespace is used when that read fails; without a key the editor is
 * simply absent instead of broken.
 *
 * @module dsh-model-studio/client
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PRESETS } from '../data/presets.generated.ts'
import { CompatEditor, type CompatSaveResult } from './CompatEditor.tsx'
import {
  createHostFace, type CompatSnapshot, type DirectorySnapshot, type HostFace, type ModelPageSnapshot,
} from './host.ts'
import { en, zh, type MessageKey, type Translate } from './locales.ts'
import { ModelOverridesPage } from './ModelOverridesPage.tsx'
import { PresetPanel } from './PresetPanel.tsx'
import type { PathOp } from './ops.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the model-studio surfaces. */
    'model-studio': MessageKey
  }
}

export const name = 'model-studio'
export const inject = ['slots', 'locale']

/** Locale namespace owning every string this plugin renders. */
export const LOCALE_NAMESPACE = 'model-studio'

/** Namespace key used when the served directory cannot be read. */
const FALLBACK_NAMESPACE = 'llm-pi-ai'

/** Business face injected into both seats. */
interface SeatFace {
  readonly t: Translate
  readonly host: HostFace
}

/**
 * Register the dictionaries and both extension areas.
 * @param ctx - browser-side plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }),
    'model-studio: dictionaries',
  )
  const bound = ctx.locale.bind(LOCALE_NAMESPACE)
  const t: Translate = (key, params) => bound(key as MessageKey, params)
  const face: SeatFace = { t, host: createHostFace(ctx) }

  // Both surfaces read the provider directory, so they wait for the llm Remote
  // instead of rendering a conflict check they cannot perform.
  ctx.inject(['remote.llm'], (scoped) => {
    scoped.slots.inject('settings.models.footer', () => scoped.slots.register({
      name: 'settings.models.footer',
      id: 'model-studio.presets',
      order: 40,
      locale: LOCALE_NAMESPACE,
      inject: () => face,
    }, PresetSeat))

    scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: 'model-studio',
      order: 70,
      label: () => t('navModels'),
      locale: LOCALE_NAMESPACE,
      inject: () => face,
    }, ModelsSeat))

    // The card seat is keyed by the settings namespace that owns the profiles.
    // That identity only exists once the llm Remote is attached, so the keys
    // are resolved from it rather than guessed.
    scoped.slots.inject('settings.models.provider-card', () => {
      const disposers: (() => void)[] = []
      let closed = false
      void resolveCardKeys(scoped).then((keys) => {
        if (closed) return
        for (const key of keys) {
          try {
            disposers.push(scoped.slots.register({
              name: 'settings.models.provider-card',
              key,
              locale: LOCALE_NAMESPACE,
              inject: () => face,
            }, CompatSeat))
          } catch {
            // Another plugin already owns this card cell; the seat is
            // exclusive, and losing it must not take the footer panel down.
          }
        }
      })
      return () => {
        closed = true
        for (const dispose of disposers) dispose()
      }
    })
  })
}

/**
 * Keys the provider-card seat must be registered under.
 * A keyed slot dispatches on the exact settings namespace, which is a profile
 * entry id chosen at deployment time, so it is read from the served directory
 * rather than hardcoded.
 * @param ctx - browser-side plugin context.
 * @returns at least one key; the shipped default when the read fails.
 */
async function resolveCardKeys(ctx: Context): Promise<string[]> {
  try {
    const directory = await createHostFace(ctx).readDirectory()
    const namespace = directory.piAiNamespace
    return namespace === undefined ? [FALLBACK_NAMESPACE] : [namespace]
  } catch {
    return [FALLBACK_NAMESPACE]
  }
}

/**
 * Footer seat: preset panel bound to the live directory.
 * @param props - slot props plus the injected face.
 * @returns the panel, or nothing while the directory is unread.
 */
function PresetSeat({ t, host }: PropsRuntime<'settings.models.footer'> & SeatFace): ReactNode {
  const [directory, setDirectory] = useState<DirectorySnapshot | undefined>(undefined)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let live = true
    void host.readDirectory().then(
      (next) => { if (live) setDirectory(next) },
      () => { if (live) setUnavailable(true) },
    )
    return () => { live = false }
  }, [host])

  if (directory === undefined && !unavailable) return null
  return (
    <PresetPanel
      t={t}
      catalog={PRESETS}
      knownRouteIds={directory?.routeIds ?? new Set<string>()}
      writable={directory?.writable === true}
      unavailable={unavailable || directory === undefined}
      onApply={preset => host.applyPreset(preset)}
    />
  )
}

/**
 * Settings-section seat: per-model overrides over the loaded profiles.
 * @param props - slot props plus the injected face.
 * @returns the page body.
 */
function ModelsSeat({ t, host }: PropsRuntime<'settings.section'> & SeatFace): ReactNode {
  const [snapshot, setSnapshot] = useState<ModelPageSnapshot | undefined>(undefined)

  useEffect(() => {
    let live = true
    void host.readModels().then(
      (next) => { if (live) setSnapshot(next) },
      () => {
        if (!live) return
        setSnapshot({ available: false, writable: false, revision: undefined, namespace: undefined, routes: [] })
      },
    )
    return () => { live = false }
  }, [host])

  // Re-read whenever the provider namespace changes (another window, the
  // official card, or this page's own write), so rows never go stale.
  const namespace = snapshot?.namespace
  useEffect(() => {
    if (namespace === undefined) return
    const refresh = (): void => { void host.readModels().then(setSnapshot) }
    return host.watchCompat(namespace, refresh)
  }, [host, namespace])

  const save = async (path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult> => {
    if (snapshot?.namespace === undefined) return { kind: 'refused', message: 'the provider namespace is unavailable' }
    const result = await host.writeCompat(snapshot.namespace, ops, snapshot.revision)
    setSnapshot(await host.readModels())
    return result
  }

  return (
    <ModelOverridesPage
      t={t}
      routes={snapshot?.routes ?? []}
      available={snapshot?.available ?? false}
      writable={snapshot?.writable ?? false}
      onSave={save}
    />
  )
}

/**
 * Provider-card seat: compatibility editor bound to one route.
 * @param props - slot owner props plus the injected face.
 * @returns the editor, or nothing when the row carries no settings address.
 */
function CompatSeat({ t, host, provider }: PropsRuntime<'settings.models.provider-card'> & SeatFace): ReactNode {
  const namespace = provider.settingsNs
  const routePath = provider.settingsPath
  const routeKey = routePath.join('\u0000')
  const [snapshot, setSnapshot] = useState<CompatSnapshot | undefined>(undefined)

  // Re-read whenever the addressed route changes; a write re-reads too, so a
  // refused or partially applied mutation cannot leave stale fields on screen.
  useEffect(() => {
    if (namespace === '' || routePath.length === 0) {
      setSnapshot(undefined)
      return
    }
    setSnapshot(host.readCompat(namespace, routePath))
    // `routeKey` covers the array identity; the segments themselves are stable.
    return host.watchCompat(namespace, () => setSnapshot(host.readCompat(namespace, routePath)))
  }, [host, namespace, routeKey])

  if (snapshot === undefined || namespace === '' || routePath.length === 0) return null

  const save = async (ops: PathOp[]): Promise<CompatSaveResult> => {
    const result = await host.writeCompat(namespace, ops, snapshot.revision)
    setSnapshot(host.readCompat(namespace, routePath))
    return result
  }

  return (
    <CompatEditor
      t={t}
      routeId={provider.provider}
      routeName={provider.displayName}
      compatPath={[...routePath, 'compat']}
      stored={snapshot.stored}
      available={snapshot.available}
      writable={snapshot.writable}
      onSave={save}
    />
  )
}
