/**
 * Selection menu entry: translate the text the reader selected in a conversation.
 *
 * The action is admitted by a text interaction (`uiConversation.interactions`)
 * and rendered through the keyed `conversation.chat.text-interaction` seat, so it
 * appears beside the Host's own selection actions instead of a floating button of
 * this plugin's own invention. The request reuses the normal translate route; no
 * `targetLanguage` is sent, so the Host applies the reader's preference.
 *
 * @module dsh-immersive-translate/client/SelectionTranslate
 */

import { useCallback, useState, type ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ApiFailure, translate } from './api.ts'
import { COLORS, quietButtonStyle } from './tokens.ts'
import type { TranslateProps } from './FloatingButton.tsx'

/** What the reader sees while the selection translation runs. */
type Phase = 'idle' | 'busy' | 'answered'

/**
 * Render the selection translate action and its small result card.
 * @param props - area-local text interaction props plus the injected `t`.
 * @returns the action, or null for a gesture this plugin does not serve.
 */
export function SelectionTranslate({
  trigger,
  readText,
  dismiss,
  t,
}: PropsRuntime<'conversation.chat.text-interaction'> & TranslateProps): ReactElement | null {
  const [phase, setPhase] = useState<Phase>('idle')
  const [answer, setAnswer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(() => {
    const selected = readText()
    if (selected === null || selected.trim() === '') {
      dismiss()
      return
    }
    setPhase('busy')
    setError(null)
    void translate({ items: [{ id: 'selection', text: selected.trim() }] })
      .then((body) => {
        setAnswer(body.results[0]?.text ?? '')
        setPhase('answered')
      })
      .catch((failure: unknown) => {
        setError(failure instanceof ApiFailure ? `${failure.code}: ${failure.message}` : String(failure))
        setPhase('answered')
      })
  }, [dismiss, readText])

  if (trigger !== 'selection') return null

  if (phase === 'answered') {
    return (
      <div
        data-dsh-translate-ui=""
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          maxWidth: 420,
          padding: 10,
          fontSize: 13,
          color: COLORS.text,
          background: COLORS.layer2,
          border: `0.5px solid ${COLORS.border}`,
          borderRadius: COLORS.radiusMd,
          boxShadow: COLORS.overlayShadow,
        }}>
        {error === null
          ? (
            <div style={{
              whiteSpace: 'pre-wrap',
              lineHeight: 1.6,
              maxHeight: 220,
              overflow: 'auto',
            }}>{answer}</div>
          )
          : <span style={{ color: COLORS.error, fontSize: 12 }}>{error}</span>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={{ ...quietButtonStyle, padding: '2px 8px', fontSize: 12 }}
            onPointerDown={(event) => { event.preventDefault() }}
            onClick={() => { dismiss() }}>
            {t('selectionClose')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      data-dsh-translate-ui=""
      // Keep the selection alive: a pointer-down default would collapse it
      // before the click handler reads the text.
      onPointerDown={(event) => { event.preventDefault() }}
      onClick={run}
      disabled={phase === 'busy'}
      style={{ ...quietButtonStyle, padding: '2px 8px', fontSize: 12 }}>
      {phase === 'busy' ? t('selectionTranslating') : t('selectionTranslate')}
    </button>
  )
}
