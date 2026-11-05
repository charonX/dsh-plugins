import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExtensionFrame } from '../src/client/ExtensionFrame.tsx'
import { PresetPanel } from '../src/client/PresetPanel.tsx'
import { CompatEditor } from '../src/client/CompatEditor.tsx'
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
  const render = (known: readonly string[] = []) => renderToStaticMarkup(
    <PresetPanel
      t={t}
      catalog={catalog}
      knownRouteIds={new Set(known)}
      writable
      onApply={async () => ({ kind: 'written' })}
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

  it('explains a read-only document instead of offering a dead button', () => {
    const html = renderToStaticMarkup(
      <PresetPanel t={t} catalog={catalog} knownRouteIds={new Set()} writable={false} onApply={async () => ({ kind: 'written' })} />,
    )
    expect(html).toContain('presetReadOnly')
  })

  it('reports a directory it could not read', () => {
    const html = renderToStaticMarkup(
      <PresetPanel t={t} catalog={catalog} knownRouteIds={new Set()} writable unavailable onApply={async () => ({ kind: 'written' })} />,
    )
    expect(html).toContain('presetsUnavailable')
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

  it('shows the stored value as the current selection', () => {
    expect(render({ thinkingFormat: 'zai' })).toContain('value="zai"')
  })

  it('disables editing when the namespace is unavailable or read-only', () => {
    expect(render(undefined, true, false)).toContain('compatUnavailable')
    expect(render(undefined, false, true)).toContain('disabled=""')
  })
})
