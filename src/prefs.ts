/**
 * Reader preferences: one small JSON file the plugin owns.
 *
 * The settings UI writes only these fields; provider credentials and model
 * configuration stay in the Host's own provider settings.
 *
 * @module dsh-immersive-translate/prefs
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TranslatePrefs } from './shared/api.js'

/** Minimal logger shape the plugin needs from `ctx.logger`. */
export interface Logger {
  warn: (message: string) => void
}

/** Durable preference store; reads are synchronous from an in-memory copy. */
export class PrefsStore {
  private current: TranslatePrefs

  /**
   * @param path - JSON file path; its directory is created on first write.
   * @param logger - warning sink for unreadable or unwritable state.
   * @param defaults - preferences used when the file is absent or invalid.
   */
  constructor(
    private readonly path: string,
    private readonly logger: Logger,
    private readonly defaults: TranslatePrefs,
  ) {
    this.current = this.load()
  }

  /**
   * @returns the current preferences, never mutated in place.
   */
  read(): TranslatePrefs {
    return this.current
  }

  /**
   * Merge one patch, persist it, and return the accepted preferences.
   * @param patch - fields to replace; `undefined` leaves a field untouched.
   * @returns the stored preferences.
   */
  update(patch: Partial<TranslatePrefs>): TranslatePrefs {
    const next = normalize({ ...this.current, ...patch }, this.defaults)
    this.current = next
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.path)
    } catch (error) {
      this.logger.warn(`immersive-translate: cannot write preferences: ${messageOf(error)}`)
    }
    return next
  }

  private load(): TranslatePrefs {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      return normalize(raw, this.defaults)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`immersive-translate: cannot read preferences: ${messageOf(error)}`)
      }
      return this.defaults
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Accept only well-shaped fields, falling back to the deployment defaults.
 * @param value - parsed file content or a merged patch.
 * @param defaults - values used for every absent or invalid field.
 * @returns a complete preference set.
 */
export function normalize(value: unknown, defaults: TranslatePrefs): TranslatePrefs {
  if (typeof value !== 'object' || value === null) return defaults
  const source = value as Record<string, unknown>
  const targetLanguage = nonEmpty(source.targetLanguage) ?? defaults.targetLanguage
  const followDefaultModel = typeof source.followDefaultModel === 'boolean'
    ? source.followDefaultModel
    : defaults.followDefaultModel
  const provider = nonEmpty(source.provider)
  const model = nonEmpty(source.model)
  return {
    targetLanguage,
    followDefaultModel,
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
