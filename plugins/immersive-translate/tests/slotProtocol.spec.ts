import { describe, expect, it } from 'vitest'
import {
  serializeTranslationSlots,
  parseTranslationSlots,
  extractSlotsFallback,
} from '../src/slotProtocol.ts'

describe('slotProtocol', () => {
  it('serializes sources with collision-free nonce and matching markers', () => {
    const sources = ['Hello world', 'Second paragraph', 'Third paragraph with "quotes"']
    const packet = serializeTranslationSlots(sources)

    expect(packet.starts).toHaveLength(3)
    expect(packet.ends).toHaveLength(3)
    expect(packet.nonce).toBeTruthy()

    for (let i = 0; i < sources.length; i += 1) {
      expect(packet.payload).toContain(packet.starts[i])
      expect(packet.payload).toContain(packet.ends[i])
      expect(packet.payload).toContain(sources[i])
    }
  })

  it('avoids collision when source text contains a matching marker', () => {
    const collidingSource = 'Text with ___DSH_TRANSLATE_mytest_0_BEGIN___ inside'
    const packet = serializeTranslationSlots([collidingSource], 'mytest')

    // The nonce should have received a collision suffix (e.g. mytest_1)
    expect(packet.nonce).not.toBe('mytest')
    expect(packet.starts[0]).not.toBe('___DSH_TRANSLATE_mytest_0_BEGIN___')
  })

  it('strictly parses valid slot responses in correct order', () => {
    const sources = ['First', 'Second', 'Third']
    const packet = serializeTranslationSlots(sources, 'nonce1')

    const response = [
      `${packet.starts[0]}\n第一\n${packet.ends[0]}`,
      `${packet.starts[1]}\n第二\n${packet.ends[1]}`,
      `${packet.starts[2]}\n第三\n${packet.ends[2]}`,
    ].join('\n\n')

    const parsed = parseTranslationSlots(packet, response)
    expect(parsed).toEqual(['第一', '第二', '第三'])
  })

  it('rejects out-of-order or duplicate markers in strict parse', () => {
    const sources = ['One', 'Two']
    const packet = serializeTranslationSlots(sources, 'testorder')

    // Swapped slots
    const swapped = [
      `${packet.starts[1]}\n第二\n${packet.ends[1]}`,
      `${packet.starts[0]}\n第一\n${packet.ends[0]}`,
    ].join('\n')
    expect(parseTranslationSlots(packet, swapped)).toBeNull()

    // Missing second slot
    const missing = `${packet.starts[0]}\n第一\n${packet.ends[0]}`
    expect(parseTranslationSlots(packet, missing)).toBeNull()
  })

  it('handles quotes, code, and special characters inside slots without syntax errors', () => {
    const sources = ['Special "quotes" and \'apostrophes\' and { JSON: "syntax" }']
    const packet = serializeTranslationSlots(sources, 'special')

    const translatedText = '特殊 "引号" 和 \'单引号\' 以及 { JSON: "语法" }'
    const response = `${packet.starts[0]}\n${translatedText}\n${packet.ends[0]}`

    const parsed = parseTranslationSlots(packet, response)
    expect(parsed).toEqual([translatedText])
  })

  it('fallback extractor recovers slots even if model outputs preamble or unclosed tags', () => {
    const sources = ['One', 'Two', 'Three']
    const packet = serializeTranslationSlots(sources, 'fallback')

    const noisyResponse = `Here is your translation:
${packet.starts[0]}
第一
${packet.ends[0]}

Some explanation from model...

${packet.starts[2]}
第三
${packet.ends[2]}`

    const recovered = extractSlotsFallback(packet, noisyResponse)
    expect(recovered.get(0)).toBe('第一')
    expect(recovered.get(1)).toBeUndefined()
    expect(recovered.get(2)).toBe('第三')
  })
})
