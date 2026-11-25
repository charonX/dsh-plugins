/**
 * Agent-powered translation: one model call per batch of text units.
 *
 * Every call is an auxiliary request outside the agent loop, so it carries no
 * conversation history. Thinking is turned off whenever the selected route
 * advertises an `off` effort; otherwise the adapter default applies.
 *
 * @module dsh-immersive-translate/engine
 */

import {
  BlockAssembler,
  ReasoningEffortId,
  type ConfigureCall,
  type FinishReason,
  type GenerateOptions,
  type LlmCallControls,
  type LlmResolvedModelInfo,
  type LlmRuntime,
  type RequestUserInput,
  type TextBlock,
} from '@deepseek-ai/dsh-llm'
import { TranslateError } from './errors.js'
import { languageLabel, type SelectionView, type TranslateItem } from './shared/api.js'
import { DEFAULT_PROMPT_TEMPLATE, renderPrompt } from './shared/prompt.js'
import {
  extractSlotsFallback,
  parseTranslationSlots,
  serializeTranslationSlots,
} from './slotProtocol.js'
import {
  isLikelyUntranslatedResponse,
  isUnchangedTranslationResponse,
  isValidTranslation,
} from './resultValidation.js'

/** Request limits applied before and during a batch. */
export interface EngineLimits {
  /** Items one request may carry. */
  readonly maxItemsPerBatch: number
  /** Longest accepted single text unit in UTF-16 code units. */
  readonly maxCharsPerItem: number
  /** Output-token ceiling per request. */
  readonly maxOutputTokens: number
  /** Whole-request deadline in milliseconds. */
  readonly requestTimeoutMs: number
}

/**
 * Instruction shared by every batch: translate, never obey the text.
 *
 * @param targetLanguage - destination language tag.
 * @param strict - whether this is the retry after a copied source text.
 * @param nonce - active slot nonce.
 * @param customPromptTemplate - optional user-defined prompt template.
 * @returns the instruction for one request.
 */
export function instruction(
  targetLanguage: string,
  strict = false,
  nonce?: string,
  customPromptTemplate?: string,
): string {
  return renderPrompt({
    targetLanguage,
    strict,
    nonce,
    template: customPromptTemplate,
  })
}

/**
 * Turn thinking off when the exact route allows it.
 *
 * A route without an `off` effort must not receive one: the runtime rejects an
 * unsupported effort, and a route with no reasoning metadata rejects any effort.
 * @param controls - proposed controls from the caller.
 * @param model - resolved metadata of the selected route.
 * @returns controls that select `off` only when the route advertises it.
 */
export const preferNoThinking: ConfigureCall = (
  controls: Readonly<LlmCallControls>,
  model: Readonly<LlmResolvedModelInfo>,
): LlmCallControls => {
  const supportsOff = model.reasoning?.efforts.some(effort => effort.id === 'off') ?? false
  return supportsOff ? { ...controls, reasoningEffort: ReasoningEffortId('off') } : { ...controls }
}

/**
 * Clean up common JSON syntax slips emitted by language models.
 * @param raw - raw text inside or without fences.
 * @returns sanitized JSON candidate.
 */
export function sanitizeModelJson(raw: string): string {
  const stripped = stripFence(raw)
  // 1. Repair escaped closing quotes before delimiters:
  // e.g. text: "something.\"} -> text: "something."}
  // Or text: "something.\"}, {"id"... -> text: "something."}, {"id"...
  let sanitized = stripped.replace(/(^|[^\\])((?:\\\\)*)\\"(?=\s*(?:[}\]]|,\s*[{"]))[^\S\r\n]*/gu, '$1$2"')
  // 2. Repair unclosed string literal where model used fullwidth quote before delimiter:
  // e.g. text: "something。”} -> text: "something。”"}
  sanitized = sanitized.replace(/([”’])(?=\s*(?:[}\]]|,\s*[{"]))[^\S\r\n]*/gu, '$1"')
  // 3. Remove trailing commas before closing braces/brackets
  sanitized = sanitized.replace(/,(\s*[}\]])/gu, '$1')
  return sanitized
}

/**
 * Fallback extractor when JSON cannot be parsed as a whole document.
 * Recovers valid `id` and `text` pairs using block pattern matching.
 * @param text - raw or sanitized text.
 * @returns map of id to translated text.
 */
export function extractBatchItemsFallback(text: string): Map<string, string> {
  const byId = new Map<string, string>()
  const blockRegex = /\{([^{}]+)\}/gu
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(text)) !== null) {
    const block = match[1]
    if (block === undefined) continue
    const idMatch = /"id"\s*:\s*"([^"]+)"/u.exec(block)
    const textMatch = /"(?:text|translation|result|target)"\s*:\s*"((?:\\.|[^"\\])*)"/u.exec(block)
    if (idMatch?.[1] !== undefined && textMatch?.[1] !== undefined) {
      const id = idMatch[1].trim()
      let val = textMatch[1]
      try {
        val = JSON.parse(`"${val}"`) as string
      } catch {
        val = val.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
      byId.set(id, val)
      if (id.startsWith('b')) byId.set(id.slice(1), val)
      else if (/^\d+$/.test(id)) byId.set(`b${id}`, val)
    }
  }
  return byId
}

/**
 * Extract id-to-text translations from a model's response text.
 * Tolerates standard array of items, object with items array,
 * object with items map, and top-level key-value mappings.
 *
 * @param text - raw or fenced assistant text.
 * @returns map of id to translated text.
 */
export function extractBatchItems(text: string): Map<string, string> {
  const sanitized = sanitizeModelJson(text)
  let payload: unknown
  try {
    payload = JSON.parse(sanitized) as unknown
  } catch (firstError) {
    try {
      payload = JSON.parse(stripFence(text)) as unknown
    } catch {
      const fallback = extractBatchItemsFallback(sanitized)
      if (fallback.size > 0) return fallback
      throw invalidOutput(firstError instanceof Error ? firstError.message : 'invalid JSON payload')
    }
  }

  if (typeof payload !== 'object' || payload === null) {
    throw invalidOutput('answer is not an item array or object')
  }

  const byId = new Map<string, string>()

  const register = (rawId: unknown, rawText: unknown): void => {
    if (rawId === undefined || rawId === null || rawText === undefined || rawText === null) return
    const id = String(rawId).trim()
    if (id === '') return
    const text = typeof rawText === 'string'
      ? rawText
      : typeof rawText === 'object' && rawText !== null && typeof (rawText as { text?: unknown }).text === 'string'
        ? (rawText as { text: string }).text
        : typeof rawText === 'object' && rawText !== null && typeof (rawText as { translation?: unknown }).translation === 'string'
          ? (rawText as { translation: string }).translation
          : String(rawText)
    byId.set(id, text)
    if (id.startsWith('b')) {
      byId.set(id.slice(1), text)
    } else if (/^\d+$/.test(id)) {
      byId.set(`b${id}`, text)
    }
  }

  if (Array.isArray(payload)) {
    for (const row of payload) {
      if (typeof row === 'object' && row !== null) {
        const record = row as Record<string, unknown>
        const val = record.text ?? record.translation ?? record.result ?? record.target
        register(record.id, val)
      }
    }
  } else {
    const obj = payload as Record<string, unknown>
    if (Array.isArray(obj.items)) {
      for (const row of obj.items) {
        if (typeof row === 'object' && row !== null) {
          const record = row as Record<string, unknown>
          const val = record.text ?? record.translation ?? record.result ?? record.target
          register(record.id, val)
        }
      }
    } else if (typeof obj.items === 'object' && obj.items !== null) {
      for (const [k, v] of Object.entries(obj.items as Record<string, unknown>)) {
        if (typeof v === 'object' && v !== null) {
          const record = v as Record<string, unknown>
          register(record.id ?? k, record.text ?? record.translation ?? record.result ?? record.target ?? v)
        } else {
          register(k, v)
        }
      }
    }

    for (const [k, v] of Object.entries(obj)) {
      if (k === 'items') continue
      if (typeof v === 'string') {
        register(k, v)
      } else if (typeof v === 'object' && v !== null) {
        const record = v as Record<string, unknown>
        register(record.id ?? k, record.text ?? record.translation ?? record.result ?? record.target)
      }
    }
  }

  return byId
}

/**
 * Read the batch answer out of the model's text.
 * @param text - assembled assistant text, possibly fenced.
 * @param expected - ids the request sent, in order.
 * @param fallback - optional fallback map when an expected item was dropped.
 * @returns translated text per id, in request order.
 */
export function parseBatchOutput(
  text: string,
  expected: readonly string[],
  fallback?: ReadonlyMap<string, string>,
): TranslateItem[] {
  const byId = extractBatchItems(text)
  return expected.map((id) => {
    const translated = byId.get(id) ?? byId.get(id.replace(/^b/, '')) ?? fallback?.get(id)
    if (translated === undefined) throw invalidOutput(`answer is missing item "${id}"`)
    return { id, text: translated }
  })
}

function invalidOutput(reason: string): TranslateError {
  return new TranslateError(502, 'INVALID_MODEL_OUTPUT', reason)
}

/**
 * Remove one surrounding Markdown code fence, if the model added one.
 * @param text - raw assistant text.
 * @returns the inner JSON text.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
}

/**
 * Determine whether a text candidate starts and ends like a JSON object or array.
 * @param raw - text string.
 */
export function isJsonStructure(raw: string): boolean {
  const t = stripFence(raw).trim()
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
}

/**
 * Clean a single-item plain text response from the model.
 * Removes code fences, markdown blockquote markers, common introductory phrases,
 * and outer quotes if the source did not have outer quotes.
 *
 * @param raw - raw text from the model.
 * @param sourceText - original source text.
 * @returns sanitized translation text.
 */
export function cleanSingleResponse(raw: string, sourceText: string): string {
  let cleaned = stripFence(raw).trim()
  cleaned = cleaned.replace(/^(?:Translation|Translated text|Output|Result|翻译|译文)\s*[:：]\s*/iu, '').trim()
  if (
    cleaned.length >= 2 &&
    ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith('“') && cleaned.endsWith('”')) ||
      (cleaned.startsWith('\'') && cleaned.endsWith('\''))) &&
    !sourceText.startsWith('"') && !sourceText.startsWith('“') && !sourceText.startsWith('\'')
  ) {
    cleaned = cleaned.slice(1, -1).trim()
  }
  return cleaned
}

/**
 * Fallback to parse line-by-line translations when the model dropped markers
 * but outputted clean lines corresponding to the requested items.
 *
 * @param raw - raw text from the model.
 * @param expectedCount - number of expected items.
 * @returns array of lines if line count matches, or null.
 */
export function extractLinesFallback(raw: string, expectedCount: number): string[] | null {
  if (expectedCount <= 1) return null
  const stripped = stripFence(raw).trim()
  const lines = stripped
    .split(/\r?\n+/)
    .map(line => line.replace(/^\s*(?:\d+[\.\)\]]|\*|-)\s*/u, '').trim())
    .filter(line => line !== '')
  if (lines.length === expectedCount) {
    return lines
  }
  return null
}

/**
 * One translated batch plus whether the route reasoned while producing it.
 *
 * `reasoned` is the only way to tell a route that honoured `off` from one whose
 * gateway defaulted to thinking: the adapter's effort list cannot answer that.
 * `attempts` and `durationMs` are recorded so a slow translation can be
 * explained after the fact - either the route reasoned, or a copied source text
 * forced a second request - instead of guessed at from how long the button spun.
 */
export interface BatchAnswer {
  /** Translated units in request order. */
  readonly items: readonly TranslateItem[]
  /** Whether any reasoning output accompanied the answer. */
  readonly reasoned: boolean
  /** Requests this batch cost: 1, or 2 when a copied source text forced a retry. */
  readonly attempts: number
  /** Wall-clock time of the whole batch across its attempts, in milliseconds. */
  readonly durationMs: number
  /**
   * Whether this answer may be cached.
   *
   * An answer that still copies its source after the retry is an echo, not a
   * translation; caching it would serve the same untranslated text forever.
   */
  readonly cacheable: boolean
}

/**
 * Whether any answer copied its source text, which means nothing was translated.
 *
 * For single-item requests, any identity indicates an echo.
 * For multi-item batches, technical terms or proper nouns (e.g. "git", "dsh")
 * may legitimately remain unchanged in the target language; a batch is only
 * flagged as an echo when the predominant majority of non-empty items echo.
 * @param items - text units the request sent.
 * @param results - answer units, in request order.
 * @returns true when answers predominantly copy their source text.
 */
export function echoesSource(
  items: readonly TranslateItem[],
  results: readonly TranslateItem[],
  targetLanguage = 'zh-CN',
): boolean {
  if (items.length === 0) return false
  const byId = new Map(results.map(row => [row.id, row.text]))
  let nonTrivial = 0
  let echoed = 0
  for (const item of items) {
    if (item.text.trim() === '') continue
    nonTrivial += 1
    const answer = byId.get(item.id)
    if (answer !== undefined && isLikelyUntranslatedResponse(item.text, answer, targetLanguage)) {
      echoed += 1
    }
  }
  if (nonTrivial === 0) return false
  return nonTrivial <= 2 ? echoed === nonTrivial : echoed / nonTrivial >= 0.75
}

/**
 * Translate one batch through the selected route.
 *
 * An answer that copies its source text is retried once with a stricter
 * instruction: a weak route returns an echo often enough that accepting it
 * would look like a broken plugin, while a second request is cheap compared to
 * a page of untranslated text. The retry result is final - repeating it would
 * only add latency for a route that cannot do better.
 *
 * If a model drops some items from a multi-item batch (common on compact or
 * MT-specialized routes), the missing items are automatically retried once in a
 * targeted request. Any item still missing after retry falls back to source text
 * rather than aborting the entire page sweep.
 * @param llm - Host LLM runtime.
 * @param selection - provider route and model id.
 * @param targetLanguage - destination language tag.
 * @param items - text units; the caller already enforced the per-item limit.
 * @param limits - request ceilings.
 * @param signal - caller cancellation, combined with the request deadline.
 * @returns translated units in request order, plus whether the route reasoned.
 */
export async function translateBatch(
  llm: LlmRuntime,
  selection: SelectionView,
  targetLanguage: string,
  items: readonly TranslateItem[],
  limits: EngineLimits,
  signal: AbortSignal,
  customPromptTemplate?: string,
): Promise<BatchAnswer> {
  if (items.length === 0) return { items: [], reasoned: false, attempts: 0, durationMs: 0, cacheable: false }
  const started = performance.now()
  const deadline = AbortSignal.timeout(limits.requestTimeoutMs)
  const combined = AbortSignal.any([signal, deadline])

  let attempts = 1
  const first = await runBatch(llm, selection, targetLanguage, items, limits, combined, false, customPromptTemplate)
  let reasoned = first.reasoned
  const resultMap = new Map<string, string>(first.translated.map(item => [item.id, item.text]))

  // 1. If any items were missed by the model, retry just the missing items
  if (first.missing.length > 0 && !combined.aborted) {
    attempts += 1
    try {
      const retryMissing = await runBatch(llm, selection, targetLanguage, first.missing, limits, combined, false, customPromptTemplate)
      reasoned = reasoned || retryMissing.reasoned
      for (const item of retryMissing.translated) {
        resultMap.set(item.id, item.text)
      }
    } catch {
      // Best-effort missing-items retry
    }
  }

  // Fallback to original text for any items that still could not be translated
  for (const item of items) {
    if (!resultMap.has(item.id)) {
      resultMap.set(item.id, item.text)
    }
  }

  let finalItems: TranslateItem[] = items.map(item => ({ id: item.id, text: resultMap.get(item.id)! }))

  // 2. If the answer copied the source text, retry once with strict instruction
  const retriedEcho = echoesSource(items, finalItems, targetLanguage)
  if (retriedEcho && attempts === 1 && !combined.aborted) {
    attempts += 1
    const second = await runBatch(llm, selection, targetLanguage, items, limits, combined, true, customPromptTemplate)
    reasoned = reasoned || second.reasoned
    for (const item of second.translated) {
      resultMap.set(item.id, item.text)
    }
    finalItems = items.map(item => ({ id: item.id, text: resultMap.get(item.id) ?? item.text }))
  }

  return {
    items: finalItems,
    reasoned,
    attempts,
    durationMs: Math.round(performance.now() - started),
    cacheable: !echoesSource(items, finalItems, targetLanguage),
  }
}

interface RunBatchResult {
  readonly translated: readonly TranslateItem[]
  readonly missing: readonly TranslateItem[]
  readonly reasoned: boolean
}

/**
 * Run one request and read the answer out of it.
 * @param llm - Host LLM runtime.
 * @param selection - provider route and model id.
 * @param targetLanguage - destination language tag.
 * @param items - text units.
 * @param limits - request ceilings.
 * @param signal - caller cancellation already combined with the deadline.
 * @param strict - whether the instruction carries the retry wording.
 * @returns translated units and any missed units in request order, plus whether the route reasoned.
 */
async function runBatch(
  llm: LlmRuntime,
  selection: SelectionView,
  targetLanguage: string,
  items: readonly TranslateItem[],
  limits: EngineLimits,
  signal: AbortSignal,
  strict: boolean,
  customPromptTemplate?: string,
): Promise<RunBatchResult> {
  const sources = items.map(item => item.text)
  const slotPacket = serializeTranslationSlots(sources)
  const messages: RequestUserInput[] = [{
    role: 'user',
    content: [{ type: 'text', text: `${instruction(targetLanguage, strict, slotPacket.nonce, customPromptTemplate)}\n\nInput slots:\n${slotPacket.payload}` }],
  }]
  const prepared = await withCancellation(
    llm.prepareCall(
      { provider: selection.provider, model: selection.model, maxTokens: limits.maxOutputTokens },
      signal,
      preferNoThinking,
    ),
    signal,
  )
  const options: GenerateOptions = { ...prepared.config, messages, signal }
  const assembler = new BlockAssembler()
  let terminal: FinishReason | undefined
  let reasoned = false
  try {
    for await (const chunk of prepared.stream(options)) {
      // A hybrid-thinking route may emit a reasoning block before its text even
      // when no effort was requested; that is slower, not wrong.
      if (chunk.type === 'tool-call-delta') {
        throw new TranslateError(502, 'INVALID_MODEL_OUTPUT', 'translation request tried to call a tool')
      }
      if (chunk.type === 'reasoning-delta' || (chunk.type === 'block-end' && chunk.block.type === 'reasoning')) {
        reasoned = true
      }
      assembler.push(chunk)
      if (chunk.type === 'finish') terminal = chunk.reason
    }
  } catch (error) {
    if (error instanceof TranslateError) throw error
    throw new TranslateError(502, 'MODEL_FAILED', failureText(error))
  }
  if (terminal === undefined) {
    throw new TranslateError(502, 'INVALID_MODEL_OUTPUT', 'translation request finished without a reason')
  }
  if (terminal.kind === 'error' || terminal.kind === 'aborted') {
    // The route's own failure carries the only useful diagnostic: a provider
    // status, an auth refusal, or a rejected parameter.
    throw new TranslateError(502, 'MODEL_FAILED', failureText(terminal.failure))
  }
  if (terminal.kind !== 'stop') {
    throw new TranslateError(502, 'INVALID_MODEL_OUTPUT', `translation request finished with "${terminal.kind}"`)
  }
  const blocks = assembler.blocks()
  const text = blocks.filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
  if (text.trim() === '') {
    throw new TranslateError(502, 'INVALID_MODEL_OUTPUT', 'translation request returned no text')
  }

  const translated: TranslateItem[] = []
  const missing: TranslateItem[] = []

  // 1. Strict slot protocol parsing
  const parsedSlots = parseTranslationSlots(slotPacket, text)
  if (parsedSlots !== null && parsedSlots.length === items.length) {
    for (let i = 0; i < items.length; i += 1) {
      translated.push({ id: items[i]!.id, text: parsedSlots[i]! })
    }
  } else {
    // 2. Fallback slot extractor
    const slotFallback = extractSlotsFallback(slotPacket, text)
    if (slotFallback.size > 0) {
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]!
        const res = slotFallback.get(i)
        if (res !== undefined) {
          translated.push({ id: item.id, text: res })
        } else {
          missing.push(item)
        }
      }
    } else {
      // 3. Fallback to JSON parsing for backwards compatibility
      let byId: Map<string, string> | undefined
      try {
        byId = extractBatchItems(text)
      } catch {
        // Not a JSON payload
      }
      if (byId !== undefined && byId.size > 0) {
        for (const item of items) {
          const res = byId.get(item.id) ?? byId.get(item.id.replace(/^b/, ''))
          if (res !== undefined) {
            translated.push({ id: item.id, text: res })
          } else {
            missing.push(item)
          }
        }
      } else if (items.length === 1 && !isJsonStructure(text)) {
        // 4. Single-item plain text fallback: when model outputs raw translated text without markers or JSON
        const clean = cleanSingleResponse(text, items[0]!.text)
        if (clean !== '') {
          translated.push({ id: items[0]!.id, text: clean })
        }
      } else if (items.length > 1 && !isJsonStructure(text)) {
        // 5. Multi-item plain line fallback: when model outputs lines corresponding to items
        const lines = extractLinesFallback(text, items.length)
        if (lines !== null) {
          for (let i = 0; i < items.length; i += 1) {
            translated.push({ id: items[i]!.id, text: lines[i]! })
          }
        }
      }
    }
  }

  if (translated.length === 0 && items.length > 0) {
    const trimmed = text.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      parseBatchOutput(text, items.map(item => item.id))
    }
    throw invalidOutput('translation response did not contain matching slot markers or translations')
  }
  return { translated, missing, reasoned }
}

/**
 * Re-wrap a rejected dependency call so cancellation stays distinguishable.
 * @param work - pending dependency call.
 * @param signal - combined caller and deadline signal.
 * @returns the resolved value.
 */
async function withCancellation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (signal.aborted) {
      throw new TranslateError(504, deadlineOf(signal) ? 'TIMEOUT' : 'CANCELED', 'translation request was cancelled')
    }
    throw new TranslateError(502, 'MODEL_FAILED', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Render one provider failure for the operator and the panel.
 * @param failure - adapter-reported failure or a thrown value.
 * @returns a single line naming the code and the provider message.
 */
function failureText(failure: unknown): string {
  if (typeof failure === 'object' && failure !== null) {
    const record = failure as { code?: unknown; message?: unknown; status?: unknown }
    // A provider failure carries a routing code; a thrown Error carries only a
    // message, and prefixing it with a synthetic code hides the real one.
    if (typeof record.code === 'string') {
      const message = typeof record.message === 'string' ? record.message : 'no message'
      const status = typeof record.status === 'number' ? ` (HTTP ${String(record.status)})` : ''
      return `${record.code}${status}: ${message}`
    }
    if (typeof record.message === 'string') return record.message
  }
  return failure instanceof Error ? failure.message : String(failure)
}

function deadlineOf(signal: AbortSignal): boolean {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
}
