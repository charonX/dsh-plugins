import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExtensionFrame } from '../src/client/ExtensionFrame.tsx'
import { PresetDialog, PresetPanel } from '../src/client/PresetPanel.tsx'
import { CompatEditor } from '../src/client/CompatEditor.tsx'
import { ModelOverridesPage } from '../src/client/ModelOverridesPage.tsx'
import type { Translate } from '../src/client/locales.ts'
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

describe('ExtensionFrame', () => {
  it('marks the area as plugin-contributed', () => {
    const html = renderToStaticMarkup(
      <ExtensionFrame t={t} title="Endpoint compatibility" surface="recessed"><p>body</p></ExtensionFrame>,
    )
    expect(html).toContain('extension')
    expect(html).toContain('extensionOwner')
    expect(html).toContain('extensionHint')
    expect(html).toContain('body')
  })

  it('starts collapsed unless asked otherwise', () => {
    const closed = renderToStaticMarkup(<ExtensionFrame t={t} title="x" surface="raised"><p>b</p></ExtensionFrame>)
    const opened = renderToStaticMarkup(<ExtensionFrame t={t} title="x" surface="raised" defaultOpen><p>b</p></ExtensionFrame>)
    expect(closed).not.toContain('open=""')
    expect(opened).toContain('open=""')
  })
})

describe('PresetPanel', () => {
  const render = (props: { writable?: boolean; unavailable?: boolean } = {}) => renderToStaticMarkup(
    <PresetPanel
      t={t}
      catalog={catalog}
      knownRouteIds={new Set()}
      writable={props.writable ?? true}
      unavailable={props.unavailable}
      onApply={async () => ({ kind: 'written' })}
    />,
  )

  it('renders one trigger labelled like the page\'s own add control', () => {
    const html = render()
    expect(html).toContain('presetsTrigger')
    expect(html).toContain('extension')
    // The catalogue stays closed until the trigger is used.
    expect(html).not.toContain('type="search"')
    expect(html).not.toContain('presetsSnapshot')
  })

  it('disables the trigger when the directory cannot be read', () => {
    expect(render({ unavailable: true })).toContain('disabled=""')
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

  it('is a labelled modal with the page-matching shell', () => {
    const html = render()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('close')
  })

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

describe('CompatEditor', () => {
  const render = (stored: unknown = undefined, writable = true, available = true) => renderToStaticMarkup(
    <CompatEditor
      t={t}
      routeId="siliconflow"
      routeName="SiliconFlow"
      compatPath={['providers', 'siliconflow', 'compat']}
      stored={stored}
      available={available}
      writable={writable}
      onSave={async () => ({ kind: 'saved' })}
    />,
  )

  it('offers auto plus every adapter format', () => {
    const html = render()
    expect(html).toContain('compatAuto')
    expect(html).toContain('qwen-chat-template')
    expect(html).toContain('max_completion_tokens')
  })

  it('offers known chat_template_kwargs shapes instead of a blank JSON box', () => {
    const html = render()
    expect(html).toContain('compatKwargsPreset')
    expect(html).toContain('enable_thinking')
    expect(html).toContain('thinking_budget')
    expect(html).toContain('compatKwargsHint')
  })

  it('shows the stored value as the current selection', () => {
    expect(render({ thinkingFormat: 'zai' })).toContain('value="zai"')
  })

  it('disables editing when the namespace is unavailable or read-only', () => {
    expect(render(undefined, true, false)).toContain('compatUnavailable')
    expect(render(undefined, false, true)).toContain('disabled=""')
  })
})

describe('ModelOverridesPage', () => {
  const routes = [
    {
      routeId: 'siliconflow',
      name: 'SiliconFlow',
      baseURL: 'https://api.siliconflow.cn/v1',
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
  ] as const

  const render = (extra: { available?: boolean; writable?: boolean } = {}) => renderToStaticMarkup(
    <ModelOverridesPage
      t={t}
      routes={routes}
      available={extra.available ?? true}
      writable={extra.writable ?? true}
      onSave={async () => ({ kind: 'saved' })}
    />,
  )

  it('lists the loaded routes and their models', () => {
    const html = render()
    expect(html).toContain('modelsTitle')
    expect(html).toContain('SiliconFlow')
    expect(html).toContain('Qwen/Qwen3-8B')
    expect(html).toContain('deepseek-ai/DeepSeek-OCR')
    expect(html).toContain('modelsCount[count=2]')
  })

  it('marks a model that already carries an override', () => {
    expect(render()).toContain('modelsOverridden[count=1]')
  })

  it('gives every model row the same action, so the list reads as one level', () => {
    const html = render()
    expect(html.match(/modelOverrideEdit/g) ?? []).toHaveLength(2)
  })

  it('does not repeat the route id when it equals the display name', () => {
    const html = renderToStaticMarkup(
      <ModelOverridesPage
        t={t}
        routes={[{
          routeId: 'gw-x',
          name: 'gw-x',
          baseURL: 'https://example.test/v1',
          models: [{
            index: 0,
            id: 'model-a',
            name: 'Model A',
            path: ['providers', 'gw-x', 'models', '0'],
          }],
        }]}
        available
        writable
        onSave={async () => ({ kind: 'saved' })}
      />,
    )
    // Only the heading carries the id as text; the row's aria-controls also
    // mentions it, which is an attribute rather than a visible duplicate.
    expect(html.match(/>gw-x</g) ?? []).toHaveLength(1)
  })

  it('explains an empty page instead of rendering nothing', () => {
    const html = renderToStaticMarkup(
      <ModelOverridesPage t={t} routes={[]} available writable onSave={async () => ({ kind: 'saved' })} />,
    )
    expect(html).toContain('modelsEmpty')
  })

  it('states why writes are unavailable', () => {
    expect(render({ available: false })).toContain('modelsUnavailable')
    expect(render({ writable: false })).toContain('modelsReadOnly')
  })
})
