/**
 * Deterministic text slot protocol for model translation requests.
 *
 * Encodes text units into collision-free slot markers, avoiding all JSON
 * syntax escaping failures, unescaped quote corruptions, and schema errors.
 *
 * @module dsh-immersive-translate/slotProtocol
 */

export interface SerializedTranslationSlots {
  /** Assembled prompt payload carrying all slots in request order. */
  readonly payload: string
  /** Begin markers in slot order. */
  readonly starts: readonly string[]
  /** End markers in slot order. */
  readonly ends: readonly string[]
  /** The unique nonce used for marker identification. */
  readonly nonce: string
}

/**
 * 32-bit FNV-1a hash over source texts to produce a stable, short nonce.
 * @param sources - source texts.
 * @returns 36-radix hash string.
 */
function hashSlotSources(sources: readonly string[]): string {
  let hash = 2166136261
  for (const source of sources) {
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 0xff
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Regex detecting slot markers for a given nonce.
 * @param nonce - identifier string.
 */
export function slotMarkerPattern(nonce: string): RegExp {
  return new RegExp(`___DSH_TRANSLATE_${nonce}_(\\d+)_(BEGIN|END)___`, 'gu')
}

/**
 * Serialize an array of source texts into collision-free slot markers.
 *
 * If any source text happens to contain a marker with the candidate nonce,
 * an incremented collision counter is appended until no collision occurs.
 *
 * @param sources - source texts in request order.
 * @param requestedNonce - optional base nonce override.
 * @returns serialized slots payload and marker lists.
 */
export function serializeTranslationSlots(
  sources: readonly string[],
  requestedNonce = hashSlotSources(sources),
): SerializedTranslationSlots {
  let nonce = requestedNonce.replace(/[^a-z0-9_-]/giu, '') || 'slots'
  let collision = 0

  const hasCollision = (candidate: string): boolean => {
    const pattern = slotMarkerPattern(candidate)
    return sources.some((source) => {
      pattern.lastIndex = 0
      return pattern.test(source)
    })
  }

  while (hasCollision(nonce)) {
    collision += 1
    nonce = `${requestedNonce}_${collision}`.replace(/[^a-z0-9_-]/giu, '')
  }

  const starts = sources.map((_, index) => `___DSH_TRANSLATE_${nonce}_${index}_BEGIN___`)
  const ends = sources.map((_, index) => `___DSH_TRANSLATE_${nonce}_${index}_END___`)
  const payload = sources
    .map((source, index) => `${starts[index]}\n${source}\n${ends[index]}`)
    .join('\n\n')

  return { payload, starts, ends, nonce }
}

/**
 * Parse model response text strictly according to the slot protocol.
 *
 * All markers must appear in exact ordinal order with no missing slots,
 * duplicated markers, or crossed slots.
 *
 * @param packet - the serialized slots sent to the model.
 * @param translated - raw model response string.
 * @returns array of translated texts corresponding to each slot, or null if strict parse failed.
 */
export function parseTranslationSlots(
  packet: SerializedTranslationSlots,
  translated: string,
): string[] | null {
  const { starts, ends, nonce } = packet
  if (starts.length === 0) return []
  if (starts.length !== ends.length) return null

  const pattern = slotMarkerPattern(nonce)
  const results: string[] = []
  let expectedIndex = 0
  let insideSlot = false
  let slotStartPos = -1
  let match: RegExpExecArray | null

  pattern.lastIndex = 0
  while ((match = pattern.exec(translated)) !== null) {
    const index = Number.parseInt(match[1]!, 10)
    const type = match[2]!

    if (!insideSlot) {
      if (type !== 'BEGIN' || index !== expectedIndex) {
        return null
      }
      insideSlot = true
      slotStartPos = match.index + match[0].length
    } else {
      if (type !== 'END' || index !== expectedIndex) {
        return null
      }
      const rawSlotContent = translated.slice(slotStartPos, match.index)
      results.push(cleanSlotContent(rawSlotContent))
      insideSlot = false
      expectedIndex += 1
    }
  }

  if (insideSlot || expectedIndex !== starts.length) {
    return null
  }

  return results
}

/**
 * Fallback parser that recovers any identifiable slots when strict parsing fails
 * (e.g. if the model dropped a marker, emitted extra chatter, or skipped one slot).
 *
 * @param packet - the serialized slots sent to the model.
 * @param translated - raw model response string.
 * @returns map of slot index to extracted translated text.
 */
export function extractSlotsFallback(
  packet: SerializedTranslationSlots,
  translated: string,
): Map<number, string> {
  const byIndex = new Map<number, string>()
  const { nonce, starts } = packet

  // 1. Block regex matching BEGIN ... END for any index
  const pairRegex = new RegExp(
    `___DSH_TRANSLATE_${nonce}_(\\d+)_BEGIN___([\\s\\S]*?)___DSH_TRANSLATE_${nonce}_\\1_END___`,
    'gu',
  )
  let match: RegExpExecArray | null
  while ((match = pairRegex.exec(translated)) !== null) {
    const index = Number.parseInt(match[1]!, 10)
    if (index >= 0 && index < starts.length) {
      byIndex.set(index, cleanSlotContent(match[2]!))
    }
  }

  if (byIndex.size === starts.length) {
    return byIndex
  }

  // 2. Unclosed BEGIN heuristic: from BEGIN(i) to BEGIN(i+1) or end of text
  const beginRegex = new RegExp(`___DSH_TRANSLATE_${nonce}_(\\d+)_BEGIN___`, 'gu')
  const begins: { index: number; pos: number }[] = []
  while ((match = beginRegex.exec(translated)) !== null) {
    begins.push({
      index: Number.parseInt(match[1]!, 10),
      pos: match.index + match[0].length,
    })
  }

  for (let i = 0; i < begins.length; i += 1) {
    const curr = begins[i]!
    if (byIndex.has(curr.index)) continue
    const nextPos = i + 1 < begins.length ? begins[i + 1]!.pos - begins[i + 1]!.index.toString().length - 28 : translated.length
    let content = translated.slice(curr.pos, nextPos)
    // Strip trailing END marker if present
    const endMarkerIndex = content.indexOf(`___DSH_TRANSLATE_${nonce}_${curr.index}_END___`)
    if (endMarkerIndex >= 0) {
      content = content.slice(0, endMarkerIndex)
    }
    const cleaned = cleanSlotContent(content)
    if (cleaned !== '') {
      byIndex.set(curr.index, cleaned)
    }
  }

  return byIndex
}

/**
 * Clean extracted slot content by trimming leading/trailing whitespace and newlines,
 * preserving internal formatting.
 */
function cleanSlotContent(raw: string): string {
  return raw.replace(/^\r?\n/u, '').replace(/\r?\n$/u, '').trim()
}
