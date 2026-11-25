/** Shared attention (question / approval / review / suggest-end) answer form used in compact mode on cards and full mode in the detail workbench. */
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AttentionView } from '../attention/wire-types.ts'
import css from './BoardPage.module.css'

/** One pending attention: compact preview + quick actions on a board card, or full context + action form in the detail workbench. */
export function AttentionAnswerForm({ attention, t, onAnswerAttention, compact = false }: {
  attention: AttentionView
  t: TranslateNS<'dshManager'>
  onAnswerAttention: (input: { attentionId: string; answer: string }) => Promise<boolean>
  compact?: boolean
}) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const submit = (text: string): void => {
    if (text.trim() === '' || busy) return
    setBusy(true)
    setFailed(false)
    void onAnswerAttention({ attentionId: attention.id, answer: text.trim() })
      .then((accepted) => {
        if (accepted) setAnswer('')
        else setFailed(true)
      })
      .finally(() => { setBusy(false) })
  }
  const isApproval = attention.kind === 'approval'
  const isDecision = isApproval || attention.kind === 'review'
  const isSuggestEnd = attention.kind === 'suggest-end'
  const isStewardSkip = attention.kind === 'question' && attention.dispatchId === 'steward' && attention.question.startsWith('[skip]')
  const isEscalation = attention.kind === 'question' && attention.question.includes('it still falls short')
  const isWatchdogStall = attention.kind === 'question' && attention.dispatchId === 'watchdog' && (attention.details?.startsWith('watchdog:stall:') ?? false)
  const isStewardConfirm = attention.kind === 'question' && attention.dispatchId === 'steward' && !isStewardSkip && !isEscalation
  const badgeKey = isApproval
    ? 'board.card.approvalBadge'
    : attention.kind === 'review'
      ? 'board.card.reviewBadge'
      : isSuggestEnd ? 'board.card.suggestEndBadge' : 'board.card.attentionBadge'
  const hasPayload = isApproval && attention.action !== undefined && typeof attention.action.payload === 'object' && attention.action.payload !== null
  return (
    <div className={css.attentionAsk} data-no-card-open="true">
      <div className={css.attentionQuestion}>
        <span className={css.attentionBadge}>{t(badgeKey)}</span>
        <span className={compact ? css.attentionQuestionCompact : css.attentionQuestionFull}>
          {isEscalation ? t('board.card.escalationHint') : isWatchdogStall ? t('board.card.watchdogStallHint') : attention.question}
        </span>
      </div>
      {!compact && attention.details !== undefined
        ? <div className={css.attentionDetails}>{attention.details}</div>
        : null}
      {!compact && hasPayload
        ? (
          <pre className={css.detailDiffPre}>
            {t('board.card.approvalPayload', { payload: JSON.stringify(attention.action?.payload, null, 2) })}
          </pre>
        )
        : null}
      {isDecision
        ? (
          <>
            <div className={css.attentionAnswerRow}>
              <button type="button" className={css.accept} disabled={busy} onClick={() => { submit('approved') }}>
                {t(isApproval ? 'board.card.approve' : 'board.card.acceptancePass')}
              </button>
              <button type="button" className={css.detailOpen} disabled={busy} onClick={() => { submit(answer.trim() === '' ? 'rejected' : `rejected: ${answer.trim()}`) }}>
                {t(isApproval ? 'board.card.reject' : 'board.card.acceptanceReturn')}
              </button>
            </div>
            <div className={css.attentionAnswerRow}>
              <input
                className={css.manualInput}
                value={answer}
                placeholder={t(isApproval ? 'board.card.opinionPlaceholder' : 'board.card.returnPlaceholder')}
                onChange={event => setAnswer(event.target.value)}
              />
            </div>
          </>
        )
        : isSuggestEnd
          ? (
            <div className={css.attentionAnswerRow}>
              <button type="button" className={css.accept} disabled={busy} onClick={() => { submit('confirmed') }}>
                {t('board.card.confirmEnd')}
              </button>
              <button type="button" className={css.detailOpen} disabled={busy} onClick={() => { submit('ignored') }}>
                {t('board.card.ignore')}
              </button>
            </div>
          )
          : isStewardSkip
            ? (
              <div className={css.attentionAnswerRow}>
                <button type="button" className={css.accept} disabled={busy} onClick={() => { submit('confirmed') }}>
                  {t('board.card.confirmSkip')}
                </button>
                <button type="button" className={css.detailOpen} disabled={busy} onClick={() => { submit('rejected') }}>
                  {t('board.card.runStage')}
                </button>
              </div>
            )
            : (
              <>
                {isEscalation
                  ? (
                    <div className={css.attentionAnswerRow}>
                      <button type="button" className={css.accept} disabled={busy} onClick={() => { submit('confirmed') }}>
                        {t('board.card.escalationPass')}
                      </button>
                      <button
                        type="button"
                        className={css.detailOpen}
                        disabled={answer.trim() === '' || busy}
                        onClick={() => { submit(`rejected: ${answer.trim()}`) }}
                      >
                        {t('board.card.escalationRework')}
                      </button>
                    </div>
                  )
                  : null}
                {isStewardConfirm
                  ? (
                    <div className={css.attentionAnswerRow}>
                      <button type="button" className={css.accept} disabled={busy} onClick={() => { submit('confirmed') }}>
                        {t('board.card.confirmDispatch')}
                      </button>
                      <button type="button" className={css.detailOpen} disabled={busy} onClick={() => { submit('reroute') }}>
                        {t('board.card.reroute')}
                      </button>
                    </div>
                  )
                  : null}
                {isWatchdogStall
                  ? (
                    <div className={css.attentionAnswerRow}>
                      <button type="button" className={css.accept} disabled={busy} onClick={() => { submit('confirmed') }}>
                        {t('board.card.watchdogContinue')}
                      </button>
                      <button type="button" className={css.reject} disabled={busy} onClick={() => { submit('rejected') }}>
                        {t('board.card.watchdogAbort')}
                      </button>
                    </div>
                  )
                  : null}
                <div className={css.attentionAnswerRow}>
                  <input
                    className={css.manualInput}
                    value={answer}
                    placeholder={isEscalation ? t('board.card.returnPlaceholder') : t('board.card.answerPlaceholder')}
                    onChange={event => setAnswer(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') submit(isEscalation && answer.trim() !== '' ? `rejected: ${answer.trim()}` : answer) }}
                  />
                  <button
                    type="button"
                    className={css.accept}
                    disabled={answer.trim() === '' || busy}
                    onClick={() => { submit(isEscalation ? `rejected: ${answer.trim()}` : answer) }}
                  >
                    {t('board.card.answer')}
                  </button>
                </div>
              </>
            )}
      {failed ? <span className={css.attentionFailed}>{t('board.card.answerFailed')}</span> : null}
    </div>
  )
}
