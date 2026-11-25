/**
 * Cache management UI: inspect stored sentence-level translations, search by text,
 * delete stale items, or clear cache by language, with pagination support.
 *
 * @module dsh-immersive-translate/client/CacheView
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { CachedItemEntry, CacheListResponse } from '../shared/api.ts'
import { TARGET_LANGUAGES, languageLabel } from '../shared/api.ts'
import { clearCache, deleteCacheItem, readCache } from './api.ts'
import { DshSelect } from './DshSelect.tsx'
import type { Translate } from './FloatingButton.tsx'
import { COLORS, inputStyle, quietButtonStyle } from './tokens.ts'

export interface CacheViewProps {
  readonly t: Translate
}

export function CacheView({ t }: CacheViewProps): ReactElement {
  const [data, setData] = useState<CacheListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [targetLanguage, setTargetLanguage] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await readCache({
        targetLanguage: targetLanguage === 'all' ? undefined : targetLanguage,
        search: search.trim() === '' ? undefined : search.trim(),
        limit: pageSize,
        offset: (page - 1) * pageSize,
      })
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, targetLanguage])

  useEffect(() => {
    void load()
  }, [load])

  const handleDelete = useCallback(async (key: string) => {
    try {
      await deleteCacheItem(key)
      if (data?.items.length === 1 && page > 1) {
        setPage(p => Math.max(1, p - 1))
      } else {
        await load()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [data?.items.length, load, page])

  const handleClear = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm(t('cacheClearConfirm'))) {
      return
    }
    try {
      await clearCache(targetLanguage === 'all' ? undefined : targetLanguage)
      setPage(1)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [load, targetLanguage, t])

  const items = data?.items ?? []
  const stats = data?.stats
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: COLORS.text }}>{t('cacheTitle')}</h3>
          <p style={{ margin: 0, color: COLORS.secondary, fontSize: 13 }}>{t('cacheSubtitle')}</p>
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
            disabled={loading || (stats?.totalCount ?? 0) === 0}
            onClick={() => { void handleClear() }}>
            {t('cacheClearAllBtn')}
          </button>
        </div>
      </header>

      {error !== null && (
        <div style={{ padding: '8px 12px', background: COLORS.layer3, color: COLORS.error, borderRadius: COLORS.radiusSm, border: `0.5px solid ${COLORS.border}` }}>
          {error}
        </div>
      )}

      {/* Filter and Search Bar */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          placeholder={t('cacheSearchPlaceholder')}
          style={{ ...inputStyle, width: '100%', maxWidth: 280 }}
        />
        <DshSelect
          ariaLabel={t('targetLanguage')}
          value={targetLanguage}
          options={[
            { value: 'all', label: t('cacheFilterAllLangs') },
            ...TARGET_LANGUAGES.map(lang => ({
              value: lang,
              label: `${languageLabel(lang)}${stats?.byLanguage[lang] !== undefined ? ` (${stats.byLanguage[lang]})` : ''}`,
            })),
          ]}
          onChange={(next) => {
            setTargetLanguage(next)
            setPage(1)
          }}
          style={{ width: 'auto', minWidth: 150 }}
        />
        {stats !== undefined && (
          <span style={{ fontSize: 12, color: COLORS.secondary, marginLeft: 'auto' }}>
            {t('cacheTotalEntries')}: <strong style={{ color: COLORS.text }}>{total}</strong>
          </span>
        )}
      </div>

      {/* Items list */}
      {items.length === 0 && !loading && (
        <div style={{ padding: 24, textAlign: 'center', color: COLORS.tertiary, background: COLORS.layer1, borderRadius: COLORS.radiusSm, border: `0.5px solid ${COLORS.border}` }}>
          {t('cacheEmpty')}
        </div>
      )}

      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map(item => (
            <CacheItemRow
              key={item.key}
              item={item}
              onDelete={() => { void handleDelete(item.key) }}
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
              options={[20, 25, 50, 100].map(size => ({
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

function CacheItemRow({
  item,
  onDelete,
  t,
}: {
  item: CachedItemEntry
  onDelete: () => void
  t: Translate
}): ReactElement {
  const dateStr = item.updatedAt > 0 ? new Date(item.updatedAt).toLocaleDateString() : '-'

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      padding: '10px 14px',
      background: COLORS.layer1,
      border: `0.5px solid ${COLORS.border}`,
      borderRadius: COLORS.radiusSm,
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
          <span style={{
            padding: '1px 5px',
            borderRadius: COLORS.radiusSm,
            color: COLORS.brand,
            border: `0.5px solid ${COLORS.brand}`,
            fontWeight: 500,
          }}>
            {languageLabel(item.targetLanguage)}
          </span>
          {dateStr !== '-' && <span style={{ color: COLORS.tertiary }}>{dateStr}</span>}
        </div>
        <div style={{ color: COLORS.secondary, wordBreak: 'break-word', lineHeight: 1.5 }}>
          {item.sourceText || <span style={{ color: COLORS.tertiary, fontStyle: 'italic' }}>[历史批次缓存]</span>}
        </div>
        <div style={{ color: COLORS.text, fontWeight: 500, wordBreak: 'break-word', lineHeight: 1.5 }}>
          {item.translation}
        </div>
      </div>

      <button
        type="button"
        style={{ ...quietButtonStyle, padding: '3px 8px', fontSize: 11, color: COLORS.error, marginTop: 2 }}
        onClick={onDelete}>
        {t('cacheDelete')}
      </button>
    </div>
  )
}
