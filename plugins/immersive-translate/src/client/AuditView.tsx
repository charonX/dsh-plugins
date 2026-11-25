/**
 * Request audit UI: lists translation batches with cache outcomes, latencies,
 * model routes, and sentence-level drilldowns.
 *
 * @module dsh-immersive-translate/client/AuditView
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AuditListResponse, RequestAuditRecord } from '../shared/api.ts'
import { languageLabel } from '../shared/api.ts'
import { clearAudit, readAudit } from './api.ts'
import { DshSelect } from './DshSelect.tsx'
import type { Translate } from './FloatingButton.tsx'
import { COLORS, quietButtonStyle } from './tokens.ts'

export interface AuditViewProps {
  readonly t: Translate
}

export function AuditView({ t }: AuditViewProps): ReactElement {
  const [data, setData] = useState<AuditListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await readAudit({ limit: pageSize, offset: (page - 1) * pageSize })
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize])

  useEffect(() => {
    void load()
  }, [load])

  const handleClear = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm(t('auditClearConfirm'))) {
      return
    }
    try {
      await clearAudit()
      setPage(1)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [load, t])

  const summary = data?.summary
  const records = data?.records ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: COLORS.text }}>{t('auditTitle')}</h3>
          <p style={{ margin: 0, color: COLORS.secondary, fontSize: 13 }}>{t('auditSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={{ ...quietButtonStyle, padding: '4px 10px', fontSize: 12 }}
            disabled={loading}
            onClick={() => { void load() }}>
            {loading ? t('loading') : t('refresh')}
          </button>
          <button
            type="button"
            style={{ ...quietButtonStyle, padding: '4px 10px', fontSize: 12, color: COLORS.error }}
            disabled={loading || records.length === 0}
            onClick={() => { void handleClear() }}>
            {t('auditClearBtn')}
          </button>
        </div>
      </header>

      {error !== null && (
        <div style={{ padding: '8px 12px', background: COLORS.layer3, color: COLORS.error, borderRadius: COLORS.radiusSm, border: `0.5px solid ${COLORS.border}` }}>
          {error}
        </div>
      )}

      {/* Summary Cards */}
      {summary !== undefined && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>{t('auditTotalRequests')}</span>
            <span style={cardValueStyle}>{summary.totalRequests}</span>
          </div>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>{t('auditOverallHitRate')}</span>
            <span style={{ ...cardValueStyle, color: COLORS.success }}>
              {Math.round(summary.overallHitRate * 100)}%
            </span>
          </div>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>{t('auditItemsBreakdown')}</span>
            <span style={cardValueStyle}>
              {summary.totalCachedItems} / {summary.totalModelItems}
            </span>
            <span style={{ fontSize: 11, color: COLORS.tertiary }}>{t('auditCachedItems')} / {t('auditModelItems')}</span>
          </div>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>{t('auditSavedTime')}</span>
            <span style={{ ...cardValueStyle, color: COLORS.brand }}>
              {(summary.estimatedSavedMs / 1000).toFixed(1)}s
            </span>
          </div>
        </div>
      )}

      {/* Record List */}
      {records.length === 0 && !loading && (
        <div style={{ padding: 24, textAlign: 'center', color: COLORS.tertiary, background: COLORS.layer1, borderRadius: COLORS.radiusSm, border: `0.5px solid ${COLORS.border}` }}>
          {t('auditEmpty')}
        </div>
      )}

      {records.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {records.map(record => (
            <RecordRow
              key={record.id}
              record={record}
              expanded={expandedId === record.id}
              onToggle={() => setExpandedId(expandedId === record.id ? null : record.id)}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Pagination Controls */}
      {total > 0 && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          padding: '8px 4px',
          fontSize: 12,
          color: COLORS.secondary,
          borderTop: `0.5px solid ${COLORS.border}`,
          marginTop: 4,
        }}>
          <div>
            {t('paginationInfo', { page, totalPages, total })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <DshSelect
              value={String(pageSize)}
              variant="compact"
              align="end"
              side="top"
              options={[10, 20, 50].map(size => ({
                value: String(size),
                label: t('paginationPageSize', { size }),
              }))}
              onChange={(next) => {
                setPageSize(Number(next))
                setPage(1)
              }}
            />

            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              style={{
                ...quietButtonStyle,
                padding: '4px 10px',
                fontSize: 12,
                opacity: page <= 1 || loading ? 0.4 : 1,
                cursor: page <= 1 || loading ? 'default' : 'pointer',
              }}>
              {t('paginationPrev')}
            </button>

            <button
              type="button"
              disabled={page >= totalPages || loading}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              style={{
                ...quietButtonStyle,
                padding: '4px 10px',
                fontSize: 12,
                opacity: page >= totalPages || loading ? 0.4 : 1,
                cursor: page >= totalPages || loading ? 'default' : 'pointer',
              }}>
              {t('paginationNext')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function RecordRow({
  record,
  expanded,
  onToggle,
  t,
}: {
  record: RequestAuditRecord
  expanded: boolean
  onToggle: () => void
  t: Translate
}): ReactElement {
  const timeStr = new Date(record.timestamp).toLocaleTimeString()

  let statusBadgeColor: string = COLORS.brand
  let statusText = t('auditStatusPartialCache')
  if (record.status === 'full_cache') {
    statusBadgeColor = COLORS.success
    statusText = t('auditStatusFullCache')
  } else if (record.status === 'model_only') {
    statusBadgeColor = COLORS.warn
    statusText = t('auditStatusModelOnly')
  } else if (record.status === 'error') {
    statusBadgeColor = COLORS.error
    statusText = t('auditStatusError')
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      background: COLORS.layer1,
      border: `0.5px solid ${COLORS.border}`,
      borderRadius: COLORS.radiusSm,
      overflow: 'hidden',
    }}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 14px',
          cursor: 'pointer',
          flexWrap: 'wrap',
          gap: 8,
          fontSize: 12,
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: COLORS.tertiary }}>{timeStr}</span>
          <span style={{
            padding: '2px 6px',
            borderRadius: COLORS.radiusSm,
            fontSize: 11,
            fontWeight: 500,
            color: statusBadgeColor,
            border: `0.5px solid ${statusBadgeColor}`,
          }}>
            {statusText}
          </span>
          <span style={{ fontWeight: 500, color: COLORS.text }}>
            {languageLabel(record.targetLanguage)}
          </span>
          <span style={{ color: COLORS.secondary }}>
            {record.provider} / {record.model}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: COLORS.secondary }}>
            {record.cachedItems} 缓存 / {record.modelItems} 模型 (共 {record.totalItems})
          </span>
          <span style={{ color: COLORS.tertiary }}>
            {record.durationMs}ms {record.aiDurationMs > 0 ? `(AI: ${record.aiDurationMs}ms)` : ''}
          </span>
          <span style={{ color: COLORS.brand, textDecoration: 'underline' }}>
            {expanded ? t('auditHideItems') : t('auditViewItems', { count: record.items.length })}
          </span>
        </div>
      </div>

      {record.error !== undefined && (
        <div style={{ padding: '6px 14px', background: COLORS.layer3, color: COLORS.error, fontSize: 12 }}>
          {record.error}
        </div>
      )}

      {expanded && (
        <div style={{
          borderTop: `0.5px solid ${COLORS.border}`,
          padding: '10px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          background: COLORS.layer2,
          fontSize: 12,
        }}>
          {record.items.map((item, idx) => (
            <div
              key={`${record.id}-${String(idx)}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '6px 0',
                borderBottom: idx < record.items.length - 1 ? `0.5px solid ${COLORS.border}` : 'none',
              }}>
              <span style={{
                padding: '1px 5px',
                borderRadius: COLORS.radiusSm,
                fontSize: 10,
                color: item.fromCache ? COLORS.success : COLORS.warn,
                border: `0.5px solid ${item.fromCache ? COLORS.success : COLORS.warn}`,
                whiteSpace: 'nowrap',
                marginTop: 2,
              }}>
                {item.fromCache ? t('auditItemCached') : t('auditItemModel')}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                <div style={{ color: COLORS.secondary }}>{item.source}</div>
                <div style={{ color: COLORS.text, fontWeight: 500 }}>{item.translation || '-'}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const cardStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 4,
  padding: '10px 14px',
  background: COLORS.layer1,
  border: `0.5px solid ${COLORS.border}`,
  borderRadius: COLORS.radiusSm,
}

const cardLabelStyle = {
  fontSize: 11,
  color: COLORS.secondary,
}

const cardValueStyle = {
  fontSize: 18,
  fontWeight: 600,
  color: COLORS.text,
}
