/**
 * Context window lookup and conservative token estimation fallbacks for
 * external agent backends that do not advertise explicit window sizes or usage.
 */
import type { ExternalAgentId } from './types.ts'

const ONE_MILLION = 1_000_000
const FOUR_HUNDRED_K = 400_000
const TWO_HUNDRED_K = 200_000
const ONE_TWENTY_EIGHT_K = 128_000

/**
 * Parse compact context sizes such as `1.0M`, `1M`, `192K`, or `128000`.
 */
export function parseContextSizeString(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([km])?$/iu.exec(trimmed)
  if (match === null) return undefined
  const num = Number(match[1])
  if (!Number.isFinite(num) || num <= 0) return undefined
  const unit = match[2]?.toLowerCase()
  if (unit === 'm') return Math.round(num * 1_000_000)
  if (unit === 'k') return Math.round(num * 1_000)
  return Math.round(num)
}

/**
 * Resolve a fallback context window when a CLI omits `contextWindow` / `size`.
 */
export function resolveFallbackContextWindow(
  agentId: ExternalAgentId,
  modelId: string | undefined,
  discoveredWindows?: Readonly<Record<string, number>>,
): number {
  const normalizedModel = (modelId ?? '').trim()
  if (normalizedModel !== '' && discoveredWindows !== undefined) {
    const exact = discoveredWindows[normalizedModel]
    if (typeof exact === 'number' && Number.isFinite(exact) && exact > 0) {
      return exact
    }
  }
  const lower = normalizedModel.toLowerCase()
  if (lower.includes('[1m]') || lower.endsWith('-1m')) return ONE_MILLION
  if (lower.includes('gemini')) return ONE_MILLION
  if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('haiku')) {
    return TWO_HUNDRED_K
  }
  if (lower.includes('gpt-5')) return FOUR_HUNDRED_K
  if (lower.includes('o3') || lower.includes('o4') || lower.includes('codex')) return TWO_HUNDRED_K
  if (lower.includes('deepseek') || lower.includes('glm') || lower.includes('qwen')) return ONE_TWENTY_EIGHT_K
  if (agentId === 'agy') return ONE_MILLION
  return TWO_HUNDRED_K
}

/**
 * Conservative heuristic token estimate used only when an external CLI settles
 * a turn without emitting provider-side token accounting.
 */
export function estimateTokensFromText(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  return Math.max(1, Math.ceil(Buffer.byteLength(trimmed, 'utf8') / 3.5))
}
