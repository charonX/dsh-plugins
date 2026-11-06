/**
 * Browser half: one settings page, and nothing injected into the official UI.
 *
 * The plugin used to render inside the official Models page (a footer entry and
 * a per-card editor). Both are gone: everything this plugin edits — adding a
 * route from a preset, a route's gateway-level compat, and per-model overrides —
 * lives on its own settings page, so the built-in page stays untouched.
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
import { createHostFace, type HostFace, type ModelPageSnapshot } from './host.ts'
import { ModelOverridesPage } from './ModelOverridesPage.tsx'
import { en, zh, type MessageKey, type Translate } from './locales.ts'
import type { PathOp } from './ops.ts'
import type { CompatSaveResult, PresetApplyResult } from './results.ts'
import type { Preset } from '../shared/preset.ts'

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

/** Business face injected into the seat. */
interface SeatFace {
  readonly t: Translate
  readonly host: HostFace
}

/**
 * Register the dictionaries and the settings page.
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

  // The page reads provider profiles, so it waits for the llm Remote before
  // rendering a conflict check it could not perform.
  ctx.inject(['remote.llm'], (scoped) => {
    scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: 'model-studio',
      order: 70,
      label: () => t('navModels'),
      locale: LOCALE_NAMESPACE,
      inject: () => face,
    }, StudioSeat))
  })
}

/** What the seat holds between renders. */
interface SeatState {
  readonly models: ModelPageSnapshot | undefined
  readonly routeIds: ReadonlySet<string>
  readonly directoryComplete: boolean
}

/**
 * Settings-section seat: the plugin's whole surface.
 * @param props - slot props plus the injected face.
 * @returns the page body.
 */
function StudioSeat({ t, host }: PropsRuntime<'settings.section'> & SeatFace): ReactNode {
  const [state, setState] = useState<SeatState>({ models: undefined, routeIds: new Set(), directoryComplete: true })

  const load = async (): Promise<SeatState> => {
    const [models, directory] = await Promise.all([host.readModels(), host.readDirectory()])
    return { models, routeIds: directory.routeIds, directoryComplete: directory.complete }
  }

  useEffect(() => {
    let live = true
    const refresh = (): void => {
      load().then(
        (next) => { if (live) setState(next) },
        (failure: unknown) => {
          // A read failure must still render (with an explanation) instead of
          // leaving the page on its initial empty state.
          console.warn('model-studio: settings page read failed', failure)
          if (live) setState(current => ({ ...current, directoryComplete: false }))
        },
      )
    }
    refresh()
    const off = host.watchSettings(refresh)
    return () => {
      live = false
      off()
    }
  }, [host])

  const refresh = async (): Promise<void> => { setState(await load()) }

  const save = async (path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult> => {
    const namespace = state.models?.namespace
    if (namespace === undefined) return { kind: 'refused', message: 'the provider namespace is unavailable' }
    const result = await host.writeCompat(namespace, ops, state.models?.revision)
    await refresh()
    return result
  }

  const applyPreset = async (preset: Preset): Promise<PresetApplyResult> => {
    const result = await host.applyPreset(preset)
    await refresh()
    return result
  }

  return (
    <ModelOverridesPage
      t={t}
      routes={state.models?.routes ?? []}
      available={state.models?.available ?? false}
      writable={state.models?.writable ?? false}
      catalog={PRESETS}
      knownRouteIds={state.routeIds}
      presetsUnavailable={!state.directoryComplete}
      onSaveModel={save}
      onSaveRoute={save}
      onApplyPreset={applyPreset}
    />
  )
}
