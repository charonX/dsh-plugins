/**
 * Turn prompt renderer: interleaves resolved template sections and immutable
 * system data blocks, enforces the 64 KB rendered size cap, and returns full
 * provenance per section for dispatch persistence and preview diagnostics.
 */
import { TURN_REGISTRY, type TurnId } from './prompt-sections.ts'
import type { PromptOverrideSource, ResolvedPromptSection } from './prompt-resolve.ts'
import { renderTemplate, type PromptRenderContext } from './prompt-vars.ts'

export const MAX_RENDERED_PROMPT_BYTES = 64 * 1024

export interface RenderedPromptSection {
  readonly id: string
  readonly text: string
  readonly source: PromptOverrideSource
  readonly locked: boolean
}

export interface RenderedTurnPrompt {
  readonly turnId: TurnId
  readonly text: string
  readonly truncated: boolean
  readonly sections: readonly RenderedPromptSection[]
  readonly missingVars: readonly string[]
  readonly unknownVars: readonly string[]
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

export function truncateUtf8Bytes(input: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const buf = utf8Encoder.encode(input)
  if (buf.byteLength <= maxBytes) {
    return { text: input, truncated: false }
  }
  const suffix = '\n...(truncated)'
  const suffixBytes = utf8Encoder.encode(suffix).byteLength
  const budget = Math.max(0, maxBytes - suffixBytes)
  // Walk back from budget to avoid splitting a multi-byte UTF-8 sequence.
  let end = budget
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1
  }
  return {
    text: `${utf8Decoder.decode(buf.subarray(0, end))}${suffix}`,
    truncated: true,
  }
}

/**
 * Render one turn prompt from resolved sections and runtime context.
 * System data blocks are inserted at their registry-defined anchors.
 */
export function renderTurn(
  turnId: TurnId,
  ctx: PromptRenderContext,
  resolved: readonly ResolvedPromptSection[],
): RenderedTurnPrompt {
  const turn = TURN_REGISTRY[turnId]
  const resolvedById = new Map(resolved.map(item => [item.id, item]))
  const sectionDefById = new Map(turn.sections.map(def => [def.id, def]))

  const chunks: string[] = []
  const renderedSections: RenderedPromptSection[] = []
  const missingSet = new Set<string>()
  const unknownSet = new Set<string>()
  const missingVars: string[] = []
  const unknownVars: string[] = []

  const collect = (target: string[], seen: Set<string>, items: readonly string[]): void => {
    for (const item of items) {
      if (!seen.has(item)) {
        seen.add(item)
        target.push(item)
      }
    }
  }

  for (const entry of turn.entries) {
    if (entry.kind === 'dataBlock') {
      const lines = ctx.dataBlocks[entry.id]
      if (lines !== undefined && lines.length > 0) {
        chunks.push(lines.join('\n'))
      }
      continue
    }

    const section = resolvedById.get(entry.id)
    const def = sectionDefById.get(entry.id)
    if (section === undefined || def === undefined) continue

    // Degraded stage fallback (deleted pipeline/member mid-flight) always takes precedence.
    if (section.id === 'stage' && ctx.degradedStageText !== undefined) {
      chunks.push(ctx.degradedStageText)
      renderedSections.push({
        id: section.id,
        text: ctx.degradedStageText,
        source: 'builtin',
        locked: false,
      })
      continue
    }

    // Check builtin conditional gate (or stage requirement).
    if (def.conditionalOn !== undefined) {
      const flagActive = ctx.flags[def.conditionalOn]
      if (!flagActive && (section.source === 'builtin' || section.id === 'stage' || section.id === 'artifacts')) {
        continue
      }
    }

    const result = renderTemplate(section.text, ctx.vars)
    collect(missingVars, missingSet, result.missing)
    collect(unknownVars, unknownSet, result.unknown)

    if (result.text.trim() === '') {
      continue
    }

    chunks.push(result.text)
    renderedSections.push({
      id: section.id,
      text: result.text,
      source: section.source,
      locked: section.locked,
    })
  }

  const joined = chunks.join('\n')
  const capped = truncateUtf8Bytes(joined, MAX_RENDERED_PROMPT_BYTES)

  return {
    turnId,
    text: capped.text,
    truncated: capped.truncated,
    sections: renderedSections,
    missingVars,
    unknownVars,
  }
}
