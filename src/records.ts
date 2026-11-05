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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendPluginRecord, SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { TranslateItem } from './shared/api.js'
import type { Logger } from './prefs.js'

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
}

/**
 * Content key of one batch request: the same source always yields the same key.
 * @param targetLanguage - destination language tag.
 * @param provider - provider route.
 * @param model - model id.
 * @param items - source units in request order.
 * @returns a stable hex digest.
 */
export function batchKey(
  targetLanguage: string,
  provider: string,
  model: string,
  items: readonly TranslateItem[],
): string {
  const canonical = JSON.stringify([targetLanguage, provider, model, items.map(item => [item.id, item.text])])
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
