import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StudioDialog } from '../src/client/StudioDialog.tsx'
import { PresetDialog } from '../src/client/PresetDialog.tsx'
import { ModelOverridesPage } from '../src/client/ModelOverridesPage.tsx'
import type { Translate } from '../src/client/locales.ts'
import type { ModelRouteView } from '../src/client/model-view.ts'
import type { PresetCatalog } from '../src/shared/preset.ts'

/** Localizer that renders keys and params verbatim, so assertions can name them. */
const t: Translate = (key, params) =>
  params === undefined ? key : `${key}[${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')}]`

const catalog: PresetCatalog = {
  source: 'https://models.dev/api.json',
  license: 'MIT',
  snapshot: '2026-11-05T00:00:00.000Z',
  skipped: { notOpenAiCompatible: 34, unusable: 2 },
  presets: [
    {
      id: 'siliconflow',
      name: 'SiliconFlow',
      api: 'openai-completions',
      baseURL: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'SILICONFLOW_API_KEY',
      compat: { thinkingFormat: 'qwen', supportsDeveloperRole: false },
      models: [{ id: 'Qwen/Qwen3-8B', name: 'Qwen3 8B', contextWindow: 32768, reasoningEfforts: { off: null, high: 'high' } }],
    },
  ],
}

const routes: readonly ModelRouteView[] = [
  {
    routeId: 'siliconflow',
    name: 'SiliconFlow',
    path: ['providers', 'siliconflow'],
    baseURL: 'https://api.siliconflow.cn/v1',
    storedCompat: { thinkingFormat: 'qwen' },
    models: [
      {
        index: 0,
        id: 'Qwen/Qwen3-8B',
        name: 'Qwen3 8B',
        path: ['providers', 'siliconflow', 'models', '0'],
        contextWindow: 32768,
        maxTokens: 8192,
        levels: ['off', 'high'],
      },
      {
        index: 1,
        id: 'deepseek-ai/DeepSeek-OCR',
        name: 'DeepSeek OCR',
        path: ['providers', 'siliconflow', 'models', '1'],
        storedCompat: { supportsThinkingTokenBudget: true },
      },
    ],
  },
]

describe('StudioDialog', () => {
  it('is a labelled modal that marks its owner', () => {
    const html = renderToStaticMarkup(
      <StudioDialog t={t} title="Title" onClose={() => {}} footer={<p>footer</p>}>
        <p>body</p>
      </StudioDialog>,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('extension')
    expect(html).toContain('extensionOwner')
    expect(html).toContain('footer')
    expect(html).toContain('body')
  })
})

describe('PresetDialog', () => {
  const render = (known: readonly string[] = [], extra: { writable?: boolean; unavailable?: boolean } = {}) => renderToStaticMarkup(
    <PresetDialog
      t={t}
      catalog={catalog}
      knownRouteIds={new Set(known)}
      writable={extra.writable ?? true}
      unavailable={extra.unavailable}
      onApply={async () => ({ kind: 'written' })}
      onClose={() => {}}
    />,
  )

  it('states where the data came from and what was excluded', () => {
    const html = render()
    expect(html).toContain('presetsSnapshot[snapshot=2026-11-05T00:00:00.000Z,license=MIT]')
    expect(html).toContain('excluded=34')
    expect(html).toContain('count=1')
  })

  it('flags a route the page already knows', () => {
    expect(render(['siliconflow'])).toContain('presetsKnown')
    expect(render()).not.toContain('presetsKnown')
  })

  it('explains a read-only document instead of offering a dead action', () => {
    expect(render([], { writable: false })).toContain('presetReadOnly')
  })

  it('reports a directory it could not read', () => {
    expect(render([], { unavailable: true })).toContain('presetsUnavailable')
  })
})

describe('ModelOverridesPage', () => {
  const render = (extra: { available?: boolean; writable?: boolean; routes?: readonly ModelRouteView[] } = {}) => renderToStaticMarkup(
    <ModelOverridesPage
      t={t}
      routes={extra.routes ?? routes}
      available={extra.available ?? true}
      writable={extra.writable ?? true}
      catalog={catalog}
      knownRouteIds={new Set(['siliconflow'])}
      onSaveModel={async () => ({ kind: 'saved' })}
      onSaveRoute={async () => ({ kind: 'saved' })}
      onApplyPreset={async () => ({ kind: 'written' })}
    />,
  )

  it('offers the preset entry from its own page', () => {
    expect(render()).toContain('presetsTrigger')
  })

  it('lists the loaded routes and their models', () => {
    const html = render()
    expect(html).toContain('SiliconFlow')
    expect(html).toContain('Qwen/Qwen3-8B')
    expect(html).toContain('deepseek-ai/DeepSeek-OCR')
    expect(html).toContain('modelsCount[count=2]')
  })

  it('exposes a gateway-level editor per route', () => {
    expect(render()).toContain('routeCompatEdit')
  })

  it('marks a model that already carries an override', () => {
    expect(render()).toContain('modelsOverridden[count=1]')
  })

  it('gives every model row the same action, so the list reads as one level', () => {
    expect((render().match(/modelOverrideEdit/g) ?? [])).toHaveLength(2)
  })

  it('does not repeat the route id when it equals the display name', () => {
    const html = render({
      routes: [{
        routeId: 'gw-x',
        name: 'gw-x',
        path: ['providers', 'gw-x'],
        baseURL: 'https://example.test/v1',
        models: [{
          index: 0,
          id: 'model-a',
          name: 'Model A',
          path: ['providers', 'gw-x', 'models', '0'],
        }],
      }],
    })
    // Only the heading carries the id as text; the row's aria-controls also
    // mentions it, which is an attribute rather than a visible duplicate.
    expect(html.match(/>gw-x</g) ?? []).toHaveLength(1)
  })

  it('explains an empty page instead of rendering nothing', () => {
    expect(render({ routes: [] })).toContain('modelsEmpty')
  })

  it('states why writes are unavailable', () => {
    expect(render({ available: false })).toContain('modelsUnavailable')
    expect(render({ writable: false })).toContain('modelsReadOnly')
  })
})
