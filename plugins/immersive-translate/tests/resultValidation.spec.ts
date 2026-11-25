import { describe, expect, it } from 'vitest'
import {
  normalizeComparable,
  hasTranslatableText,
  isUnchangedTranslationResponse,
  isLikelyUntranslatedResponse,
  isValidTranslation,
} from '../src/resultValidation.ts'

describe('resultValidation', () => {
  describe('normalizeComparable', () => {
    it('normalizes NFKC, zero-width chars, colons, and whitespace', () => {
      const input = '  Hello\u200B ： "world"  \n'
      expect(normalizeComparable(input)).toBe('Hello : "world"')
    })
  })

  describe('hasTranslatableText', () => {
    it('returns true for text with letters in any language', () => {
      expect(hasTranslatableText('Hello')).toBe(true)
      expect(hasTranslatableText('你好')).toBe(true)
      expect(hasTranslatableText('123 abc')).toBe(true)
    })

    it('returns false for pure numbers, whitespace, and symbols', () => {
      expect(hasTranslatableText('12345')).toBe(false)
      expect(hasTranslatableText('   ---   ')).toBe(false)
      expect(hasTranslatableText('!@#$%^&*()')).toBe(false)
    })
  })

  describe('isUnchangedTranslationResponse', () => {
    it('detects identical source and translation', () => {
      expect(isUnchangedTranslationResponse('Hello world', 'Hello world')).toBe(true)
      expect(isUnchangedTranslationResponse('  Hello world! ', 'hello world.')).toBe(true)
    })

    it('returns false for actual translations', () => {
      expect(isUnchangedTranslationResponse('Hello world', '你好世界')).toBe(false)
      expect(isUnchangedTranslationResponse('Good morning', 'Bonjour')).toBe(false)
    })
  })

  describe('isLikelyUntranslatedResponse', () => {
    it('detects untranslated English when translating to Chinese', () => {
      expect(isLikelyUntranslatedResponse('Spawn N parallel candidates', 'Spawn N parallel candidates', 'zh-CN')).toBe(true)
      expect(isLikelyUntranslatedResponse('Use for "automate me"', 'Use for "automate me"', 'zh-CN')).toBe(true)
      expect(isLikelyUntranslatedResponse('Hello world', 'Just another english', 'zh-CN')).toBe(true)
    })

    it('accepts valid Chinese translations', () => {
      expect(isLikelyUntranslatedResponse('Spawn N candidates', '生成 N 个候选', 'zh-CN')).toBe(false)
      expect(isLikelyUntranslatedResponse('Hello', '你好', 'zh-CN')).toBe(false)
    })

    it('handles non-Chinese target languages', () => {
      expect(isLikelyUntranslatedResponse('Hello', 'Bonjour', 'fr')).toBe(false)
      expect(isLikelyUntranslatedResponse('Hello', 'Hello', 'fr')).toBe(true)
    })
  })

  describe('isValidTranslation', () => {
    it('validates genuine translations and rejects echoes or empty strings', () => {
      expect(isValidTranslation('zh-CN', 'Hello', '你好')).toBe(true)
      expect(isValidTranslation('zh-CN', 'Hello', 'Hello')).toBe(false)
      expect(isValidTranslation('zh-CN', '', '')).toBe(false)
      expect(isValidTranslation('zh-CN', 'Hello', '')).toBe(false)
    })
  })
})
