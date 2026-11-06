import { describe, expect, it } from 'vitest'
import { isTranslateShortcut, type SubmitKeyInput } from '../src/shared/keys.ts'

/** A plain Enter press inside the translate box. */
const enter: SubmitKeyInput = {
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 13,
}

describe('isTranslateShortcut in Enter mode', () => {
  it('submits on a plain Enter', () => {
    expect(isTranslateShortcut(enter, 'enter')).toBe(true)
  })

  it('still submits on Ctrl/Cmd+Enter for readers who press it out of habit', () => {
    expect(isTranslateShortcut({ ...enter, metaKey: true }, 'enter')).toBe(true)
    expect(isTranslateShortcut({ ...enter, ctrlKey: true }, 'enter')).toBe(true)
  })

  it('leaves Shift+Enter for a line break', () => {
    expect(isTranslateShortcut({ ...enter, shiftKey: true }, 'enter')).toBe(false)
  })

  it('ignores Enter while an IME composition is open', () => {
    expect(isTranslateShortcut({ ...enter, isComposing: true }, 'enter')).toBe(false)
  })

  it('ignores the legacy IME keyCode 229', () => {
    expect(isTranslateShortcut({ ...enter, keyCode: 229 }, 'enter')).toBe(false)
  })

  it('ignores auto-repeat while Enter is held', () => {
    expect(isTranslateShortcut({ ...enter, repeat: true }, 'enter')).toBe(false)
  })

  it('accepts the numeric Enter key', () => {
    expect(isTranslateShortcut({ ...enter, key: 'NumpadEnter' }, 'enter')).toBe(true)
  })

  it('ignores every other key', () => {
    expect(isTranslateShortcut({ ...enter, key: 'a' }, 'enter')).toBe(false)
    expect(isTranslateShortcut({ ...enter, key: 'Escape' }, 'enter')).toBe(false)
  })
})

describe('isTranslateShortcut in Ctrl/Cmd+Enter mode', () => {
  it('leaves a plain Enter for a line break', () => {
    expect(isTranslateShortcut(enter, 'mod-enter')).toBe(false)
  })

  it('submits on Ctrl+Enter and on Cmd+Enter', () => {
    expect(isTranslateShortcut({ ...enter, ctrlKey: true }, 'mod-enter')).toBe(true)
    expect(isTranslateShortcut({ ...enter, metaKey: true }, 'mod-enter')).toBe(true)
  })

  it('keeps the IME guard', () => {
    expect(isTranslateShortcut({ ...enter, ctrlKey: true, isComposing: true }, 'mod-enter')).toBe(false)
    expect(isTranslateShortcut({ ...enter, metaKey: true, repeat: true }, 'mod-enter')).toBe(false)
  })

  it('defaults to Enter mode when no mode is passed', () => {
    expect(isTranslateShortcut(enter)).toBe(true)
  })
})
