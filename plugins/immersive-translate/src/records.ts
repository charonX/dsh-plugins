/**
 * Session trace and payload archive for every batch.
 *
 * The Session log receives one lightweight pointer per batch: language, route,
 * recipe, content key, and item count. The exact source and result text live in
 * the plugin's own archive, keyed by the same content hash, so the request stays
 * reconstructable without inflating the Session log.
 *
 * @module dsh-immersive-translate/records
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appendPluginRecord, SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { CachedItemEntry, TranslateItem } from './shared/api.js'
import type { Logger } from './prefs.js'
import { isValidTranslation } from './resultValidation.js'

export { isValidTranslation } from './resultValidation.js'
export type { CachedItemEntry } from './shared/api.js'

/** One durable pointer written into the Session log for a translated batch. */
export interface TranslateBatchRecord {
  /** Destination language tag. */
  readonly targetLanguage: string
  /** Provider route that produced the translation. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Semantic recipe identity, so a later change to the prompt is visible. */
  readonly recipe: string
  /** Content key of the archived payload; also the future cache key. */
  readonly storeKey: string
  /** Number of text units in the batch. */
  readonly itemCount: number
  /** Whether the route reasoned while translating, which is what makes it slow. */
  readonly reasoned: boolean
  /** Requests the batch cost: 2 means a copied source text forced a retry. */
  readonly attempts: number
  /** Wall-clock time of the batch, in milliseconds. */
  readonly durationMs: number
  /** Whether the answer was served from the archive instead of the model. */
  readonly cached: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** One translated batch: route, recipe, and where its exact payload is archived. */
    'plugin:immersive-translate/batch': TranslateBatchRecord
  }
}

/** Exact source and result of one batch, archived on disk. */
export interface BatchPayload {
  readonly targetLanguage: string
  readonly provider: string
  readonly model: string
  readonly items: readonly TranslateItem[]
  readonly results: readonly TranslateItem[]
  /** Whether the route reasoned while translating. */
  readonly reasoned: boolean
  /** Requests the batch cost: 2 means a copied source text forced a retry. */
  readonly attempts: number
  /** Wall-clock time of the batch, in milliseconds. */
  readonly durationMs: number
  /**
   * Whether this answer may be replayed.
   *
   * False for an answer that copied its source text even after the retry: an
   * echo stored as a translation would be served forever.
   */
  readonly cacheable: boolean
}

/** Everything that decides one batch answer, and therefore its content key. */
export interface BatchIdentity {
  /** Semantic recipe identity: a prompt or control change must miss the cache. */
  readonly recipe: string
  /** Destination language tag. */
  readonly targetLanguage: string
  /** Provider route. */
  readonly provider: string
  /** Model id. */
  readonly model: string
  /** Source units in request order. */
  readonly items: readonly TranslateItem[]
}

/**
 * Content key of one batch request: the same identity always yields the same key.
 *
 * The recipe is part of the digest because the answer depends on the prompt:
 * keying only on text plus route would serve a translation produced by an older
 * instruction after the prompt changes, which is exactly the bug a cache is
 * supposed to make impossible.
 * @param identity - what decides the answer.
 * @returns a stable hex digest.
 */
export function batchKey(identity: BatchIdentity): string {
  const { recipe, targetLanguage, provider, model, items } = identity
  const canonical = JSON.stringify([
    recipe,
    targetLanguage,
    provider,
    model,
    items.map(item => [item.id, item.text]),
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/** Content-addressed archive of batch payloads. */
export class BatchArchive {
  /**
   * @param dir - archive root; created on first write.
   * @param logger - warning sink for archive failures.
   */
  constructor(private readonly dir: string, private readonly logger: Logger) {}

  /**
   * Store one payload under its content key.
   * @param key - key returned by {@link batchKey}.
   * @param payload - exact source and result.
   * @returns whether the payload reached the disk.
   */
  write(key: string, payload: BatchPayload): boolean {
    try {
      mkdirSync(this.dir, { recursive: true })
      const path = join(this.dir, `${key}.json`)
      const temporary = `${path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(temporary, path)
      return true
    } catch (error) {
      this.logger.warn(`immersive-translate: cannot archive batch: ${messageOf(error)}`)
      return false
    }
  }

  /**
   * Read one archived payload back.
   * @param key - content key.
   * @returns the payload, or undefined when it is absent or unreadable.
   */
  read(key: string): BatchPayload | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${key}.json`), 'utf8')) as BatchPayload
    } catch {
      return undefined
    }
  }
}

/**
 * Content key for a single text unit in a target language.
 * Normalized to ignore superficial whitespace differences.
 */
export function itemKey(targetLanguage: string, text: string): string {
  const normalized = text.trim().replace(/\s+/gu, ' ')
  return createHash('sha256').update(JSON.stringify([targetLanguage, normalized])).digest('hex')
}

/**
 * Persistent sentence-level archive loaded into memory for 0ms lookup.
 * Stored at `~/.dsh/immersive-translate/items.json`.
 */
export class ItemArchive {
  private readonly memory = new Map<string, CachedItemEntry>()

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
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'string') {
              // Legacy format: string translation only
              if (/[a-zA-Z]{3,}/u.test(v) && !/\p{Script=Han}/u.test(v)) {
                continue
              }
              this.memory.set(k, {
                key: k,
                targetLanguage: 'zh-CN',
                sourceText: '',
                translation: v,
                updatedAt: 0,
              })
            } else if (typeof v === 'object' && v !== null) {
              const entry = v as Partial<CachedItemEntry>
              if (typeof entry.translation === 'string' && entry.translation.trim() !== '') {
                this.memory.set(k, {
                  key: k,
                  targetLanguage: entry.targetLanguage ?? 'zh-CN',
                  sourceText: entry.sourceText ?? '',
                  translation: entry.translation,
                  updatedAt: entry.updatedAt ?? 0,
                })
              }
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn(`immersive-translate: cannot load items cache: ${messageOf(error)}`)
    }
  }

  get(targetLanguage: string, text: string): string | undefined {
    const key = itemKey(targetLanguage, text)
    const entry = this.memory.get(key)
    if (entry === undefined) return undefined
    if (!isValidTranslation(targetLanguage, text, entry.translation)) {
      this.memory.delete(key)
      return undefined
    }
    // If sourceText wasn't stored (legacy format), backfill it in memory
    if (entry.sourceText === '') {
      this.memory.set(key, { ...entry, sourceText: text.trim().replace(/\s+/gu, ' ') })
    }
    return entry.translation
  }

  setMany(targetLanguage: string, entries: readonly { text: string; translation: string }[]): void {
    let changed = 0
    const now = Date.now()
    for (const entry of entries) {
      if (!isValidTranslation(targetLanguage, entry.text, entry.translation)) continue
      const src = entry.text.trim().replace(/\s+/gu, ' ')
      const dst = entry.translation.trim()
      const key = itemKey(targetLanguage, src)
      const existing = this.memory.get(key)
      if (existing === undefined || existing.translation !== dst) {
        this.memory.set(key, {
          key,
          targetLanguage,
          sourceText: src,
          translation: dst,
          updatedAt: now,
        })
        changed += 1
      }
    }
    if (changed > 0) {
      this.save()
    }
  }

  delete(key: string): boolean {
    const deleted = this.memory.delete(key)
    if (deleted) {
      this.save()
    }
    return deleted
  }

  clear(targetLanguage?: string): number {
    let count = 0
    if (targetLanguage === undefined || targetLanguage === 'all') {
      count = this.memory.size
      this.memory.clear()
    } else {
      for (const [k, v] of this.memory) {
        if (v.targetLanguage === targetLanguage) {
          this.memory.delete(k)
          count += 1
        }
      }
    }
    if (count > 0) {
      this.save()
    }
    return count
  }

  list(filter?: {
    targetLanguage?: string
    search?: string
    limit?: number
    offset?: number
  }): { items: CachedItemEntry[]; total: number } {
    let entries = Array.from(this.memory.values())
    if (filter?.targetLanguage && filter.targetLanguage !== 'all') {
      entries = entries.filter(e => e.targetLanguage === filter.targetLanguage)
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase()
      entries = entries.filter(e =>
        e.sourceText.toLowerCase().includes(q) || e.translation.toLowerCase().includes(q)
      )
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt)
    const total = entries.length
    const offset = Math.max(0, filter?.offset ?? 0)
    const limit = Math.max(1, filter?.limit ?? 50)
    const paginated = entries.slice(offset, offset + limit)
    return { items: paginated, total }
  }

  stats(): { totalCount: number; byLanguage: Record<string, number> } {
    const byLanguage: Record<string, number> = {}
    for (const v of this.memory.values()) {
      byLanguage[v.targetLanguage] = (byLanguage[v.targetLanguage] ?? 0) + 1
    }
    return { totalCount: this.memory.size, byLanguage }
  }

  save(): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const obj: Record<string, CachedItemEntry> = {}
      for (const [k, v] of this.memory) {
        obj[k] = v
      }
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify(obj, null, 2), 'utf8')
      renameSync(temporary, this.path)
      return true
    } catch (error) {
      this.logger.warn(`immersive-translate: cannot persist items cache: ${messageOf(error)}`)
      return false
    }
  }

  size(): number {
    return this.memory.size
  }

  /**
   * Seed item cache from existing batch archive files if cache is empty.
   * @param batchDir - directory containing archived batch json files.
   * @returns number of seeded items.
   */
  seedFromBatches(batchDir: string): number {
    try {
      if (!existsSync(batchDir)) return 0
      const files = readdirSync(batchDir)
      let count = 0
      const now = Date.now()
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = readFileSync(join(batchDir, file), 'utf8')
          const data = JSON.parse(raw) as Partial<BatchPayload>
          if (typeof data.targetLanguage === 'string' && Array.isArray(data.items) && Array.isArray(data.results)) {
            const resMap = new Map(data.results.map(r => [r.id, r.text]))
            for (const item of data.items) {
              const trans = resMap.get(item.id)?.trim()
              if (trans !== undefined && isValidTranslation(data.targetLanguage, item.text, trans)) {
                const src = item.text.trim().replace(/\s+/gu, ' ')
                const key = itemKey(data.targetLanguage, src)
                const existing = this.memory.get(key)
                if (existing === undefined) {
                  this.memory.set(key, {
                    key,
                    targetLanguage: data.targetLanguage,
                    sourceText: src,
                    translation: trans,
                    updatedAt: now,
                  })
                  count += 1
                } else if (existing.sourceText === '') {
                  this.memory.set(key, {
                    ...existing,
                    sourceText: src,
                    targetLanguage: data.targetLanguage,
                  })
                }
              }
            }
          }
        } catch {
          // ignore corrupted batch file
        }
      }
      if (count > 0) {
        this.save()
      }
      return count
    } catch {
      return 0
    }
  }
}

/**
 * Append the batch pointer to an active Session.
 *
 * Best effort by contract: an inactive Session, a Host without Session storage,
 * or a refused write leaves the translation itself unaffected.
 * @param ctx - plugin context; `sessions` is read dynamically.
 * @param sessionId - Session that triggered the translation.
 * @param record - pointer payload.
 * @param logger - warning sink.
 * @returns whether the pointer was committed.
 */
export async function appendBatchPointer(
  ctx: { get: (name: 'sessions') => SessionStoreLike | undefined },
  sessionId: string,
  record: TranslateBatchRecord,
  logger: Logger,
): Promise<boolean> {
  const sessions = ctx.get('sessions')
  const session = sessions?.get(SessionId(sessionId))
  if (sessions === undefined || session === undefined) return false
  try {
    appendPluginRecord(session, 'plugin:immersive-translate/batch', frozen(record))
    await sessions.flush(session)
    return true
  } catch (error) {
    logger.warn(`immersive-translate: cannot record batch pointer: ${messageOf(error)}`)
    return false
  }
}

/** Minimal structural view of the Host Session store this module uses. */
interface SessionStoreLike {
  get: (id: ReturnType<typeof SessionId>) => Session | undefined
  flush: (session: Session) => Promise<boolean>
}

function frozen(record: TranslateBatchRecord): TranslateBatchRecord {
  return Object.freeze({ ...record })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
