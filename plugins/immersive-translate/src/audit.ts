/**
 * Audit trail for translation requests and model calls.
 *
 * Keeps an in-memory ring of recent requests with durable persistence at
 * `~/.dsh/immersive-translate/audit.json`. Enables auditing of cache hits,
 * cache misses, model call latencies, and item breakdowns.
 *
 * @module dsh-immersive-translate/audit
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from './prefs.js'
import type {
  AuditSummary,
  RequestAuditItem,
  RequestAuditRecord,
  RequestCacheStatus,
} from './shared/api.js'

export type {
  AuditSummary,
  RequestAuditItem,
  RequestAuditRecord,
  RequestCacheStatus,
} from './shared/api.js'

/** Max records kept in memory and on disk. */
const MAX_AUDIT_RECORDS = 500

/** Store managing request audit records in memory and on disk. */
export class AuditStore {
  private records: RequestAuditRecord[] = []

  constructor(
    private readonly path: string,
    private readonly logger: Logger,
  ) {
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          this.records = parsed.filter(isValidAuditRecord)
          if (this.records.length > MAX_AUDIT_RECORDS) {
            this.records = this.records.slice(0, MAX_AUDIT_RECORDS)
          }
        }
      }
    } catch (error) {
      this.logger.warn(`immersive-translate: cannot load audit logs: ${messageOf(error)}`)
    }
  }

  /**
   * Record one completed translation request.
   * @param record - audit record payload.
   */
  addRecord(record: RequestAuditRecord): void {
    this.records.unshift(record)
    if (this.records.length > MAX_AUDIT_RECORDS) {
      this.records = this.records.slice(0, MAX_AUDIT_RECORDS)
    }
    this.save()
  }

  /**
   * List paginated audit records and computed summary.
   * @param limit - max records to return (default 50).
   * @param offset - starting index (default 0).
   * @returns paginated records and summary.
   */
  list(limit = 50, offset = 0): {
    records: RequestAuditRecord[]
    total: number
    summary: AuditSummary
  } {
    const total = this.records.length
    const start = Math.max(0, offset)
    const end = Math.min(total, start + Math.max(1, limit))
    const paginated = this.records.slice(start, end)
    const summary = this.computeSummary()
    return { records: paginated, total, summary }
  }

  /**
   * Compute aggregated summary metrics across all recorded requests.
   */
  computeSummary(): AuditSummary {
    let totalItems = 0
    let totalCachedItems = 0
    let totalModelItems = 0
    let totalDurationMs = 0
    let totalAiDurationMs = 0

    for (const r of this.records) {
      totalItems += r.totalItems
      totalCachedItems += r.cachedItems
      totalModelItems += r.modelItems
      totalDurationMs += r.durationMs
      totalAiDurationMs += r.aiDurationMs
    }

    const overallHitRate = totalItems === 0 ? 0 : Math.round((totalCachedItems / totalItems) * 100) / 100
    // Estimate avg time per model item, then multiply by cached items
    const avgMsPerModelItem = totalModelItems === 0 ? 300 : Math.round(totalAiDurationMs / totalModelItems)
    const estimatedSavedMs = totalCachedItems * avgMsPerModelItem

    return {
      totalRequests: this.records.length,
      totalItems,
      totalCachedItems,
      totalModelItems,
      overallHitRate,
      totalDurationMs,
      totalAiDurationMs,
      estimatedSavedMs,
    }
  }

  /**
   * Clear all recorded audit records.
   */
  clear(): void {
    this.records = []
    this.save()
  }

  private save(): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify(this.records, null, 2), 'utf8')
      renameSync(temporary, this.path)
      return true
    } catch (error) {
      this.logger.warn(`immersive-translate: cannot persist audit logs: ${messageOf(error)}`)
      return false
    }
  }

  size(): number {
    return this.records.length
  }
}

function isValidAuditRecord(v: unknown): v is RequestAuditRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<RequestAuditRecord>
  return (
    typeof r.id === 'string' &&
    typeof r.timestamp === 'number' &&
    typeof r.targetLanguage === 'string' &&
    typeof r.totalItems === 'number' &&
    typeof r.cachedItems === 'number' &&
    typeof r.modelItems === 'number' &&
    Array.isArray(r.items)
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
