/**
 * Result validation for translation responses.
 *
 * Verifies that candidate translations are genuine, non-empty, and in the
 * requested target language, rejecting source echoes and untranslated fallbacks
 * before caching or DOM presentation.
 *
 * @module dsh-immersive-translate/resultValidation
 */

/**
 * Normalize a text for comparison:
 * - Unicode NFKC normalization
 * - Strip zero-width characters (ZWSP, ZWNJ, ZWJ, BOM)
 * - Collapse whitespace runs to single space and trim edges
 * - Normalize fullwidth colons and quotes
 *
 * @param value - string to normalize.
 * @returns canonical comparable string.
 */
export function normalizeComparable(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/[：:]/gu, ':')
    .replace(/[“”"']/gu, '"')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Determine whether a text contains translatable linguistic characters
 * (as opposed to pure numbers, symbols, punctuation, or whitespace).
 *
 * @param text - source text.
 * @returns true if text contains at least one letter.
 */
export function hasTranslatableText(text: string): boolean {
  return /\p{L}/u.test(text)
}

/**
 * Compare whether the translation response copied the source text without translating it.
 * Ignores trivial whitespace, case, and boundary punctuation differences.
 *
 * @param source - original source text.
 * @param translation - translation response.
 * @returns true if translation is an unchanged echo of source.
 */
export function isUnchangedTranslationResponse(source: string, translation: string): boolean {
  if (source.trim() === '' || translation.trim() === '') return false
  const src = normalizeComparable(source).toLowerCase()
  const dst = normalizeComparable(translation).toLowerCase()
  if (src === dst) return true

  // Strip punctuation to check if word sequence is identical
  const stripPunct = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const srcWords = stripPunct(src)
  const dstWords = stripPunct(dst)
  return srcWords !== '' && srcWords === dstWords
}

/**
 * Determine whether a translation response is likely untranslated or in the wrong language.
 *
 * For Chinese target languages (zh, zh-CN, etc.):
 * If source contains Latin words, the translation MUST contain Chinese characters (Hanzi).
 * A pure Latin output when translating to Chinese is rejected as an untranslated echo.
 *
 * @param source - source text.
 * @param translation - candidate translation.
 * @param targetLanguage - requested destination language tag.
 * @returns true if the response is likely untranslated.
 */
export function isLikelyUntranslatedResponse(
  source: string,
  translation: string,
  targetLanguage: string,
): boolean {
  const src = source.trim()
  const dst = translation.trim()
  if (src === '' || dst === '') return true

  if (isUnchangedTranslationResponse(src, dst)) {
    return true
  }

  const tag = targetLanguage.toLowerCase()
  if (tag.startsWith('zh')) {
    // If source contains 2 or more Latin letters (e.g. English word or sentence)
    if (/[a-zA-Z]{2,}/u.test(src)) {
      // Translation must contain at least one Chinese Han character
      if (!/\p{Script=Han}/u.test(dst)) {
        return true
      }
    }
  }

  return false
}

/**
 * Top-level validation gate: confirms whether a translation result is valid,
 * meaningful, and safe to cache and display.
 *
 * @param targetLanguage - destination language tag.
 * @param source - source text.
 * @param translation - candidate translation.
 * @returns true if the translation is valid.
 */
export function isValidTranslation(
  targetLanguage: string,
  source: string,
  translation: string,
): boolean {
  return !isLikelyUntranslatedResponse(source, translation, targetLanguage)
}
