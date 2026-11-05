/**
 * The shared "extension area" shell.
 *
 * Both surfaces render inside the official Models page, so each one has to say
 * who contributed it: a separator, a collapsed disclosure, and an ownership
 * marker. Colours come from Host tokens only, so both themes switch together.
 *
 * @module dsh-model-studio/client/ExtensionFrame
 */

import { useState, type ReactNode } from 'react'
import { badgeStyle, bodyStyle, frameStyle, summaryStyle } from './tokens.ts'
import type { Translate } from './locales.ts'

/** Props of {@link ExtensionFrame}. */
export interface ExtensionFrameProps {
  /** Localizer for the ownership marker. */
  t: Translate
  /** Area title, e.g. "Endpoint compatibility". */
  title: string
  /**
   * Body surface: `raised` on the settings page (a card on the page
   * background), `recessed` inside a provider card (a well inside the card).
   */
  surface: 'raised' | 'recessed'
  /** Whether the disclosure starts expanded. */
  defaultOpen?: boolean
  /** Area body. */
  children: ReactNode
}

/**
 * Render one plugin-contributed area inside an official page.
 * @param props - title, surface, and body.
 * @returns the framed area.
 */
export function ExtensionFrame({ t, title, surface, defaultOpen = false, children }: ExtensionFrameProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const owner = `${t('extension')} · ${t('extensionOwner')}`
  return (
    <section style={frameStyle} aria-label={`${title} — ${owner}`}>
      <details
        open={open}
        onToggle={event => setOpen(event.currentTarget.open)}
      >
        <summary style={summaryStyle}>
          <span>{title}</span>
          <span style={badgeStyle} title={t('extensionHint')}>{owner}</span>
        </summary>
        <div style={bodyStyle(surface)}>{children}</div>
      </details>
    </section>
  )
}
