/**
 * The workbench composer: one input whose meaning follows the ticket's state —
 * dispatch a todo ticket, steer a running turn, or reopen and resume an ended
 * one. A pending attention blocks the input until it is answered.
 */
import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TicketView } from '../board-domain.ts'
import css from './BoardPage.module.css'

const DRAFT_PREFIX = 'dsh-manager.ticket-draft.'

function readDraft(ticketId: string): string {
  try {
    return globalThis.sessionStorage?.getItem(DRAFT_PREFIX + ticketId) ?? ''
  } catch {
    return ''
  }
}

function writeDraft(ticketId: string, text: string): void {
  try {
    if (text === '') globalThis.sessionStorage?.removeItem(DRAFT_PREFIX + ticketId)
    else globalThis.sessionStorage?.setItem(DRAFT_PREFIX + ticketId, text)
  } catch {
    // Storage is optional; the draft simply does not persist.
  }
}

export function TicketComposer({ ticketId, state, hasPendingAttention, sending, failed, onSend, t }: {
  ticketId: string
  state: TicketView['state']
  hasPendingAttention: boolean
  sending: boolean
  failed: boolean
  onSend: (text: string) => void
  t: TranslateNS<'dshManager'>
}) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    setText(readDraft(ticketId))
  }, [ticketId])
  useEffect(() => {
    writeDraft(ticketId, text)
  }, [ticketId, text])

  const disabled = sending || hasPendingAttention
  const label = sending
    ? t('board.composer.sending')
    : hasPendingAttention
      ? t('board.composer.answerFirst')
      : state === 'running'
        ? t('board.composer.send')
        : state === 'ended'
          ? t('board.composer.continue')
          : t('board.composer.dispatch')
  const hint = hasPendingAttention
    ? t('board.composer.hint.attention')
    : state === 'running'
      ? t('board.composer.hint.running')
      : state === 'ended'
        ? t('board.composer.hint.ended')
        : t('board.composer.hint.todo')
  const placeholder = hasPendingAttention
    ? t('board.composer.placeholder.attention')
    : state === 'running'
      ? t('board.composer.placeholder.running')
      : state === 'ended'
        ? t('board.composer.placeholder.ended')
        : t('board.composer.placeholder.todo')

  const submit = (): void => {
    const next = text.trim()
    if (next === '' || disabled) return
    setText('')
    onSend(next)
  }

  return (
    <div className={css.composerWrap}>
      <div className={css.composerHint}>{hint}</div>
      {failed ? <div className={css.composerError}>{t('board.composer.failed')}</div> : null}
      <div className={css.composerBox}>
        <textarea
          ref={inputRef}
          className={css.composerInput}
          value={text}
          rows={2}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={placeholder}
          onChange={event => { setText(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            submit()
          }}
        />
        <Button variant="primary" size="sm" disabled={disabled || text.trim() === ''} onClick={submit}>
          {label}
        </Button>
      </div>
      <div className={css.composerFoot}>{t('board.composer.enterHint')}</div>
    </div>
  )
}
