/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  SOURCE_ATTRIBUTE,
  TRANSLATION_ATTRIBUTE,
  applyTranslation,
  clearTranslations,
  pendingBlocks,
} from '../src/client/pageDom.ts'

/** Render one fixture into the document body. */
function mount(html: string): void {
  document.body.innerHTML = html
}

/** Source texts the scanner considers pending, in document order. */
function pendingTexts(): string[] {
  return pendingBlocks(document.body).map(block => block.text)
}

beforeEach(() => { document.body.innerHTML = '' })

describe('pendingBlocks: what counts as one block', () => {
  it('splits div-based card content instead of missing it', () => {
    // The reported bug: the skills page is built from divs, so a tag whitelist
    // found one paragraph and then claimed the page had nothing to translate.
    mount(`
      <div class="card">
        <div class="name">architect</div>
        <div class="desc">Sketch types, signatures, and module structure.</div>
        <div class="meta">skills/architect</div>
      </div>`)
    expect(pendingTexts()).toEqual([
      'architect',
      'Sketch types, signatures, and module structure.',
      'skills/architect',
    ])
  })

  it('keeps inline markup in one block, in order', () => {
    mount('<p>Use <strong>care</strong> and <code>git status</code> here.</p>')
    // `code` is never sent; the rest of the sentence stays one unit.
    expect(pendingTexts()).toEqual(['Use care and here.'])
  })

  it('translates a nested block once, at the inner element', () => {
    mount('<li><p>Innermost text</p></li>')
    expect(pendingTexts()).toEqual(['Innermost text'])
  })

  it('treats an inline-only container as one block', () => {
    mount('<div class="row"><span>Skills</span><span>97</span></div>')
    expect(pendingTexts()).toEqual(['Skills 97'])
  })

  it('skips pre, code, form controls and contenteditable', () => {
    mount(`
      <pre><code>const a = 1</code></pre>
      <div><input value="typed"><textarea>draft</textarea></div>
      <div contenteditable="true">editable text</div>`)
    expect(pendingTexts()).toEqual([])
  })

  it('does not send literal source that sits inside a skippable subtree', () => {
    mount('<div class="body">Configure the key<pre>api_key = 1</pre></div>')
    expect(pendingTexts()).toEqual(['Configure the key'])
  })

  it('skips the plugin’s own surface', () => {
    mount('<div data-dsh-translate-ui><div>沉浸式翻译</div><p>粘贴要翻译的文字</p></div>')
    expect(pendingTexts()).toEqual([])
  })

  it('skips a hidden subtree', () => {
    mount('<div style="display:none"><div>hidden text</div></div><div>visible text</div>')
    expect(pendingTexts()).toEqual(['visible text'])
  })

  it('ignores whitespace-only blocks', () => {
    mount('<div>   </div><div>real</div>')
    expect(pendingTexts()).toEqual(['real'])
  })
})

describe('pendingBlocks: translation memory', () => {
  it('does not return a block that is already translated and unchanged', () => {
    mount('<div class="desc">Sketch types</div>')
    const [block] = pendingBlocks(document.body)
    expect(block).toBeDefined()
    applyTranslation(block!, '勾勒类型')
    expect(pendingTexts()).toEqual([])
  })

  it('returns a block again when its text changed under a translation', () => {
    mount('<div class="desc">Sketch types</div>')
    const [block] = pendingBlocks(document.body)
    applyTranslation(block!, '勾勒类型')
    const target = document.querySelector('.desc')!
    target.textContent = 'Streaming answer, second chunk'
    expect(pendingTexts()).toEqual(['Streaming answer, second chunk'])
    expect(target.getAttribute(TRANSLATION_ATTRIBUTE)).toBeNull()
  })

  it('clears every translation on restore', () => {
    mount('<div class="a">one</div><div class="b">two</div>')
    for (const block of pendingBlocks(document.body)) applyTranslation(block, '译文')
    expect(document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)).toHaveLength(2)
    clearTranslations(document)
    expect(document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)).toHaveLength(0)
    expect(document.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)).toHaveLength(0)
  })
})
