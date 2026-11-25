/**
 * Test-bench facade for the primitives package: the barrel pulls the whole
 * markdown renderer (shiki, katex), so the vitest alias can't target
 * `src/index.ts`. The client code under test uses the icons face plus
 * SegmentedTabs, Modal, StateDot, and SegmentedControl; all are light, so
 * this facade re-exports exactly those.
 */
import { createElement } from 'react'
export * from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx'
export { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
export type { ButtonVariant } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
export { Tag } from '@deepseek-ai/dsh-client-ui-primitives/src/Tag.tsx'
export type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives/src/Tag.tsx'
export { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives/src/SegmentedTabs.tsx'
export type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives/src/SegmentedTabs.tsx'
export { Modal } from '@deepseek-ai/dsh-client-ui-primitives/src/Modal.tsx'
export { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
export type { MenuEntry, MenuItem } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
export { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
export { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives/src/SegmentedControl.tsx'
export type { SegmentedControlOption } from '@deepseek-ai/dsh-client-ui-primitives/src/SegmentedControl.tsx'
export type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives/src/markdown/MarkdownText.tsx'

/** Lightweight jsdom test facade for `MarkdownText` without pulling `shiki`/`katex`. */
export function MarkdownText({ text }: { readonly text: string }) {
  return createElement('div', { 'data-testid': 'markdown-text' }, text)
}
