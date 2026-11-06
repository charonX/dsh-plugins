/**
 * Dialog shell for this plugin's own surfaces.
 *
 * The Models page renders its dialogs through the primitives package, which is
 * not an installable client module for an out-of-tree plugin. This shell copies
 * the page's dialog geometry from Host tokens (mask, radius, elevation, header,
 * footer) so a plugin dialog reads as the same product instead of a new one.
 * It owns only chrome: the caller supplies the title, body, and action row.
 *
 * @module dsh-model-studio/client/StudioDialog
 */

import { useEffect, useId, type ReactNode } from 'react'
import {
  badgeStyle,
  dialogBodyStyle,
  dialogCloseStyle,
  dialogFooterStyle,
  dialogHeaderStyle,
  dialogMaskStyle,
  dialogRootStyle,
  dialogStyle,
  dialogTitleStyle,
} from './tokens.ts'
import type { Translate } from './locales.ts'

/** Props of {@link StudioDialog}. */
export interface StudioDialogProps {
  /** Localizer for the ownership marker and the close label. */
  t: Translate
  /** Dialog title. */
  title: string
  /** Dismissal (close button, Escape, mask click). */
  onClose(): void
  /** Action row, right-aligned. */
  footer: ReactNode
  /** Dialog body. */
  children: ReactNode
}

/**
 * Render one modal dialog on the page's own mask and elevation.
 * @param props - title, dismissal, body, and actions.
 * @returns the dialog layer.
 */
export function StudioDialog({ t, title, onClose, footer, children }: StudioDialogProps): ReactNode {
  const titleId = useId()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  return (
    <div style={dialogRootStyle}>
      <div style={dialogMaskStyle} onClick={onClose} aria-hidden="true" />
      <div
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div style={dialogHeaderStyle}>
          <h2 id={titleId} style={dialogTitleStyle}>{title}</h2>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={badgeStyle} title={t('extensionHint')}>
              {t('extension')}
              {' · '}
              {t('extensionOwner')}
            </span>
            <button
              type="button"
              style={dialogCloseStyle}
              onClick={onClose}
              aria-label={t('close')}
              title={t('close')}
            >
              ×
            </button>
          </span>
        </div>
        <div style={dialogBodyStyle}>{children}</div>
        <div style={dialogFooterStyle}>{footer}</div>
      </div>
    </div>
  )
}
