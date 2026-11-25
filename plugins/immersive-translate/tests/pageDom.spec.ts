/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  OWNED_ATTRIBUTE,
  PLACEHOLDER_ATTRIBUTE,
  PLACEHOLDER_CLASS,
  SOURCE_ATTRIBUTE,
  STATUS_ATTRIBUTE,
  SUBTITLE_CLASS,
  TRANSLATION_ATTRIBUTE,
  applyTranslation,
  clearPlaceholder,
  clearPlaceholders,
  clearTranslations,
  findOwnedSub,
  installPageStyles,
  isElementInViewport,
  pendingBlocks,
  setPlaceholder,
} from '../src/client/pageDom.ts'
import {
  consolidateRoots,
  isAbortError,
  yieldToMain,
} from '../src/client/pageTranslator.ts'

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

  it('does not set translation attribute when translation is identical to source text or empty', () => {
    mount('<div class="a">Original</div><div class="b">Same</div>')
    const blocks = pendingBlocks(document.body)
    applyTranslation(blocks[0]!, 'Original') // identical
    applyTranslation(blocks[1]!, '   ') // empty
    expect(document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)).toHaveLength(0)
  })

  it('installs styling with brand indicator bar and distinct subtitle styling', () => {
    const uninstall = installPageStyles()
    const styleEl = document.getElementById('dsh-immersive-translate-page')
    expect(styleEl).not.toBeNull()
    const css = styleEl?.textContent ?? ''
    expect(css).toContain('border-left: 2px solid var(--dsw-alias-brand-primary')
    expect(css).toContain('font-size: 0.9em')
    expect(css).toContain('font-weight: 400')
    expect(css).toContain('@keyframes dsh-tr-pulse')
    expect(css).toContain(`.${PLACEHOLDER_CLASS}`)
    expect(css).toContain(`.${SUBTITLE_CLASS}`)
    expect(css).toContain('[data-status="active"]')
    expect(css).toContain('[data-status="pending"]')
    expect(css).toContain('user-select: text')
    uninstall()
    expect(document.getElementById('dsh-immersive-translate-page')).toBeNull()
  })

  it('sets, updates, and clears placeholders on elements with real DOM nodes', () => {
    mount('<div class="a">Card text</div>')
    const element = document.querySelector('.a') as HTMLElement
    setPlaceholder(element, 'pending', '等待翻译…')
    expect(element.getAttribute(PLACEHOLDER_ATTRIBUTE)).toBe('等待翻译…')
    expect(element.getAttribute(STATUS_ATTRIBUTE)).toBe('pending')
    const sub1 = findOwnedSub(element)
    expect(sub1).not.toBeNull()
    expect(sub1?.className).toBe(PLACEHOLDER_CLASS)
    expect(sub1?.getAttribute(OWNED_ATTRIBUTE)).toBe('true')
    expect(sub1?.getAttribute('translate')).toBe('no')
    expect(sub1?.getAttribute('data-status')).toBe('pending')
    expect(sub1?.textContent).toBe('等待翻译…')

    setPlaceholder(element, 'active', '正在翻译…')
    expect(element.getAttribute(PLACEHOLDER_ATTRIBUTE)).toBe('正在翻译…')
    expect(element.getAttribute(STATUS_ATTRIBUTE)).toBe('active')
    const sub2 = findOwnedSub(element)
    expect(sub2).toBe(sub1) // Reuses existing node
    expect(sub2?.getAttribute('data-status')).toBe('active')
    expect(sub2?.textContent).toBe('正在翻译…')

    clearPlaceholder(element)
    expect(element.getAttribute(PLACEHOLDER_ATTRIBUTE)).toBeNull()
    expect(element.getAttribute(STATUS_ATTRIBUTE)).toBeNull()
    expect(findOwnedSub(element)).toBeNull()
  })

  it('creates real selectable subtitle DOM nodes upon applyTranslation', () => {
    mount('<div class="a">Hello world</div>')
    const [block] = pendingBlocks(document.body)
    expect(block).toBeDefined()
    applyTranslation(block!, '你好，世界')
    expect(block!.element.getAttribute(TRANSLATION_ATTRIBUTE)).toBe('你好，世界')
    const sub = findOwnedSub(block!.element)
    expect(sub).not.toBeNull()
    expect(sub?.className).toBe(SUBTITLE_CLASS)
    expect(sub?.getAttribute(OWNED_ATTRIBUTE)).toBe('true')
    expect(sub?.getAttribute('translate')).toBe('no')
    expect(sub?.textContent).toBe('你好，世界')

    clearTranslations(document.body)
    expect(findOwnedSub(block!.element)).toBeNull()
  })

  it('detects whether elements are in viewport or offscreen', () => {
    mount('<div class="in-view">Inside</div><div class="off-screen">Outside</div>')
    const inEl = document.querySelector('.in-view')!
    const offEl = document.querySelector('.off-screen')!
    inEl.getBoundingClientRect = () => ({
      top: 100, bottom: 200, left: 50, right: 250, width: 200, height: 100, x: 50, y: 100, toJSON: () => {},
    })
    offEl.getBoundingClientRect = () => ({
      top: 5000, bottom: 5100, left: 50, right: 250, width: 200, height: 100, x: 50, y: 5000, toJSON: () => {},
    })

    expect(isElementInViewport(inEl)).toBe(true)
    expect(isElementInViewport(offEl)).toBe(false)
  })

  it('applyTranslation clears placeholder attributes even when translation is skipped', () => {
    mount('<div class="a">Original</div>')
    const [block] = pendingBlocks(document.body)
    setPlaceholder(block!.element, 'active', '正在翻译…')
    applyTranslation(block!, 'Original') // identical text -> translation skipped
    expect(block!.element.getAttribute(PLACEHOLDER_ATTRIBUTE)).toBeNull()
    expect(block!.element.getAttribute(STATUS_ATTRIBUTE)).toBeNull()
    expect(block!.element.getAttribute(TRANSLATION_ATTRIBUTE)).toBeNull()
  })

  it('clearTranslations clears both translations and placeholders', () => {
    mount('<div class="a">one</div><div class="b">two</div>')
    const [b1, b2] = pendingBlocks(document.body)
    applyTranslation(b1!, '译文一')
    setPlaceholder(b2!.element, 'pending', '等待翻译…')
    expect(document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)).toHaveLength(1)
    expect(document.querySelectorAll(`[${PLACEHOLDER_ATTRIBUTE}]`)).toHaveLength(1)

    clearTranslations(document)
    expect(document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)).toHaveLength(0)
    expect(document.querySelectorAll(`[${PLACEHOLDER_ATTRIBUTE}]`)).toHaveLength(0)
    expect(document.querySelectorAll(`[${STATUS_ATTRIBUTE}]`)).toHaveLength(0)
  })

  it('clearPlaceholders only clears placeholder attributes in subtree', () => {
    mount('<div class="a">one</div><div class="b">two</div>')
    const [b1, b2] = pendingBlocks(document.body)
    applyTranslation(b1!, '译文一')
    setPlaceholder(b2!.element, 'active', '正在翻译…')

    clearPlaceholders(document.body)
    expect(document.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)).toHaveLength(1)
    expect(document.querySelectorAll(`[${PLACEHOLDER_ATTRIBUTE}]`)).toHaveLength(0)
    expect(document.querySelectorAll(`[${STATUS_ATTRIBUTE}]`)).toHaveLength(0)
  })
})

describe('isAbortError', () => {
  it('detects aborted signals', () => {
    const controller = new AbortController()
    controller.abort()
    expect(isAbortError(new Error('something'), controller.signal)).toBe(true)
  })

  it('detects DOMException AbortError and abort message strings', () => {
    expect(isAbortError(new DOMException('signal is aborted without reason', 'AbortError'))).toBe(true)
    expect(isAbortError(new Error('signal is aborted without reason'))).toBe(true)
    expect(isAbortError(new Error('The user aborted a request.'))).toBe(true)
  })

  it('does not classify general errors as aborts', () => {
    expect(isAbortError(new Error('Failed to fetch'))).toBe(false)
    expect(isAbortError(new Error('Network timeout'))).toBe(false)
    expect(isAbortError('string error')).toBe(false)
  })
})

describe('consolidateRoots and yieldToMain', () => {
  it('collapses nested child nodes into their outermost dirty ancestor', () => {
    mount(`
      <div id="parent">
        <div id="child">
          <p id="grandchild">Nested text</p>
        </div>
      </div>
      <div id="sibling">Other tree</div>
    `)
    const parent = document.getElementById('parent')!
    const child = document.getElementById('child')!
    const grandchild = document.getElementById('grandchild')!
    const sibling = document.getElementById('sibling')!

    const consolidated = consolidateRoots([child, grandchild, parent, sibling])
    expect(consolidated).toHaveLength(2)
    expect(consolidated).toContain(parent)
    expect(consolidated).toContain(sibling)
    expect(consolidated).not.toContain(child)
    expect(consolidated).not.toContain(grandchild)
  })

  it('yieldToMain resolves cleanly without throwing', async () => {
    await expect(yieldToMain()).resolves.toBeUndefined()
  })
})
