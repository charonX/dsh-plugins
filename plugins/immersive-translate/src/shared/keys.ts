/**
 * Key rule for the translate box.
 *
 * It lives in `shared` rather than in the component so it stays free of DOM and
 * React types: the rule is the part worth testing, and a component importing
 * `react` cannot be unit-tested in the Node test environment.
 *
 * @module dsh-immersive-translate/shared/keys
 */

import { DEFAULT_SUBMIT_KEY, type SubmitKey } from './api.ts'

/** The small slice of a keydown event this rule reads. */
export interface SubmitKeyInput {
  /** `KeyboardEvent.key`. */
  readonly key: string
  /** `KeyboardEvent.shiftKey`. */
  readonly shiftKey: boolean
  /** `KeyboardEvent.metaKey`. */
  readonly metaKey: boolean
  /** `KeyboardEvent.ctrlKey`. */
  readonly ctrlKey: boolean
  /** `KeyboardEvent.repeat`: true while the key is held down. */
  readonly repeat: boolean
  /** `KeyboardEvent.isComposing`: true while an IME composition is open. */
  readonly isComposing: boolean
  /** `KeyboardEvent.keyCode`, still the only IME signal some engines send. */
  readonly keyCode: number
}

/**
 * Whether one keydown in the translate box should start a translation.
 *
 * The rule is applied to the textarea itself, never globally: a frame-wide
 * hotkey would fire while the reader is typing in the conversation, in the
 * settings page, or in another plugin's form, which is exactly the kind of
 * shortcut this plugin must not own. The reader chooses between "Enter"
 * (Shift+Enter stays a line break) and "Ctrl/Cmd+Enter" (Enter stays a line
 * break); the mode changes nothing outside that box.
 * @param event - the keydown fields to judge.
 * @param mode - which key the reader picked.
 * @returns true when the event should submit the box.
 */
export function isTranslateShortcut(
  event: SubmitKeyInput,
  mode: SubmitKey = DEFAULT_SUBMIT_KEY,
): boolean {
  // Browsers report the numeric Enter as "Enter"; `NumpadEnter` is accepted for
  // the engines that report the physical key instead.
  if ((event.key !== 'Enter' && event.key !== 'NumpadEnter') || event.shiftKey) return false
  // Holding Enter must not queue a request per repeat.
  if (event.repeat) return false
  // Enter confirms an IME candidate first; submitting here would swallow the
  // composition and translate a half-typed word. `keyCode` 229 is the legacy
  // signal an engine sends when it is still composing.
  if (event.isComposing || event.keyCode === 229) return false
  // In "Enter" mode a modifier is optional, so Ctrl/Cmd+Enter keeps working for
  // readers who habitually press it; in "Ctrl/Cmd+Enter" mode it is required.
  return mode === 'mod-enter' ? event.metaKey || event.ctrlKey : true
}
