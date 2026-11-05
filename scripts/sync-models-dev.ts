/**
 * Regenerate `src/data/presets.generated.ts` from models.dev.
 *
 * Build-time only: the runtime never reaches the network. Every exclusion is
 * counted into the generated header so the UI can explain why a gateway is
 * absent instead of silently omitting it.
 *
 * Usage:
 *   node scripts/sync-models-dev.ts                 # fetch https://models.dev/api.json
 *   node scripts/sync-models-dev.ts --input <file>  # use a local snapshot (offline runs, tests)
 *
 * @module dsh-model-studio/scripts/sync-models-dev
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildPreset, isOpenAiCompatible, type ModelsDevProvider } from '../src/preset-pick.ts'
import type { PresetCatalog } from '../src/shared/preset.ts'

/** Upstream snapshot location. */
const SOURCE = 'https://models.dev/api.json'

/** Upstream license, recorded in the generated file. */
const LICENSE = 'MIT'

/** Generated module, relative to this script. */
const OUTPUT = new URL('../src/data/presets.generated.ts', import.meta.url)

/** Read the snapshot from `--input` or from the network. */
async function readSnapshot(): Promise<{ providers: Record<string, ModelsDevProvider>; snapshot: string }> {
  const index = process.argv.indexOf('--input')
  if (index !== -1) {
    const path = process.argv[index + 1]
    if (path === undefined) throw new Error('--input needs a file path')
    const text = await readFile(path, 'utf8')
    return { providers: JSON.parse(text) as Record<string, ModelsDevProvider>, snapshot: `local:${path}` }
  }
  const response = await fetch(SOURCE, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`models.dev answered ${String(response.status)}`)
  const providers = await response.json() as Record<string, ModelsDevProvider>
  return { providers, snapshot: new Date().toISOString() }
}

/**
 * Build the catalogue and count what the protocol filter excluded.
 * @param providers - snapshot entries keyed by provider id.
 * @param snapshot - provenance timestamp stamped into the generated file.
 * @returns catalogue plus the exclusion counters.
 */
function buildCatalogue(
  providers: Record<string, ModelsDevProvider>,
  snapshot: string,
): { catalogue: PresetCatalog; skipped: { notOpenAiCompatible: number; unusable: number } } {
  const presets = []
  const skipped = { notOpenAiCompatible: 0, unusable: 0 }
  for (const provider of Object.values(providers)) {
    if (!isOpenAiCompatible(provider)) {
      skipped.notOpenAiCompatible += 1
      continue
    }
    const preset = buildPreset(provider)
    if (preset === undefined) {
      skipped.unusable += 1
      continue
    }
    presets.push(preset)
  }
  presets.sort((left, right) => left.id.localeCompare(right.id))
  return {
    catalogue: { source: SOURCE, license: LICENSE, snapshot, skipped, presets },
    skipped,
  }
}

/**
 * Render the generated module.
 * One preset per line keeps regeneration diffs readable.
 * @param catalogue - catalogue to serialize.
 * @returns module source.
 */
function render(catalogue: PresetCatalog): string {
  const presets = catalogue.presets.map(preset => `    ${JSON.stringify(preset)},`).join('\n')
  return `/** Generated from ${SOURCE} by \`node scripts/sync-models-dev.ts\`. Do not edit. */

/**
 * Source: ${catalogue.source}
 * License: ${catalogue.license}
 * Snapshot: ${catalogue.snapshot}
 * Presets: ${String(catalogue.presets.length)}
 * Excluded: ${String(catalogue.skipped.notOpenAiCompatible)} non-OpenAI-compatible, ${String(catalogue.skipped.unusable)} unusable
 */

import type { PresetCatalog } from '../shared/preset.ts'

/** Snapshot-derived provider presets. */
export const PRESETS: PresetCatalog = {
  source: ${JSON.stringify(catalogue.source)},
  license: ${JSON.stringify(catalogue.license)},
  snapshot: ${JSON.stringify(catalogue.snapshot)},
  skipped: { notOpenAiCompatible: ${String(catalogue.skipped.notOpenAiCompatible)}, unusable: ${String(catalogue.skipped.unusable)} },
  presets: [
${presets}
  ],
}
`
}

const { providers, snapshot } = await readSnapshot()
const { catalogue, skipped } = buildCatalogue(providers, snapshot)
await writeFile(OUTPUT, render(catalogue), 'utf8')
console.log(
  `presets: ${String(catalogue.presets.length)} written to ${fileURLToPath(OUTPUT)}`
  + ` (excluded ${String(skipped.notOpenAiCompatible)} non-OpenAI-compatible, ${String(skipped.unusable)} unusable)`,
)
