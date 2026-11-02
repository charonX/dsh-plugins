/**
 * Sparse manager state: per-source and per-skill enablement, categories, and
 * notes.
 *
 * Defaults are never written, so the file stays minimal and an absent entry
 * reads as "enabled, no note, no category". Writes use a temporary file plus
 * rename so a crash cannot leave a half-written state file.
 *
 * @module dsh-skills-manager/state
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WarnLogger } from './library.js'

/** Persisted state of one source. */
export interface SourceState {
  readonly enabled?: boolean
  readonly category?: string
  readonly note?: string
}

/** Persisted state of one skill, keyed by `source/skillName`. */
export interface SkillState {
  readonly enabled?: boolean
  readonly note?: string
}

/** On-disk state document. */
export interface StateFile {
  readonly version: 1
  readonly sources: Record<string, SourceState>
  readonly skills: Record<string, SkillState>
}

/** Patch accepted by {@link StateStore.patchSource}. */
export interface SourceStatePatch {
  readonly enabled?: boolean
  readonly category?: string
  readonly note?: string
}

/** Patch accepted by {@link StateStore.patchSkill}. */
export interface SkillStatePatch {
  readonly enabled?: boolean
  readonly note?: string
}

const STATE_VERSION = 1

/**
 * Compose the state key of one skill.
 * @param source - source slug.
 * @param skillName - skill directory name.
 * @returns the key used in `state.skills`.
 */
export function skillStateKey(source: string, skillName: string): string {
  return `${source}/${skillName}`
}

/** Read-modify-write store for the manager state file. */
export class StateStore {
  /**
   * @param path - absolute state file path.
   * @param logger - receives warnings for an unreadable state file.
   */
  constructor(
    readonly path: string,
    private readonly logger: WarnLogger,
  ) {}

  /**
   * Read the current state, tolerating a missing or malformed file.
   * @returns the parsed state document.
   */
  read(): StateFile {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return emptyState()
    }
    try {
      return normalizeState(JSON.parse(raw) as unknown)
    } catch (error) {
      this.logger.warn(`skills-manager: ignoring unreadable state file ${this.path}: ${errorMessage(error)}`)
      return emptyState()
    }
  }

  /**
   * Apply a patch to one source and persist the result.
   * @param slug - source slug.
   * @param patch - fields to set; an empty note or category clears it.
   * @returns the persisted state.
   */
  patchSource(slug: string, patch: SourceStatePatch): StateFile {
    const state = this.read()
    const current = state.sources[slug] ?? {}
    const next = pruneSourceState({ ...current, ...patch })
    const sources = { ...state.sources }
    if (next === undefined) delete sources[slug]
    else sources[slug] = next
    return this.write({ ...state, sources })
  }

  /**
   * Apply a patch to one skill and persist the result.
   * @param source - source slug.
   * @param skillName - skill directory name.
   * @param patch - fields to set; an empty note clears it.
   * @returns the persisted state.
   */
  patchSkill(source: string, skillName: string, patch: SkillStatePatch): StateFile {
    const state = this.read()
    const key = skillStateKey(source, skillName)
    const current = state.skills[key] ?? {}
    const next = pruneSkillState({ ...current, ...patch })
    const skills = { ...state.skills }
    if (next === undefined) delete skills[key]
    else skills[key] = next
    return this.write({ ...state, skills })
  }

  /**
   * Drop every state entry of one removed source.
   * @param slug - source slug.
   * @returns the persisted state.
   */
  dropSource(slug: string): StateFile {
    const state = this.read()
    const sources = { ...state.sources }
    delete sources[slug]
    const skills: Record<string, SkillState> = {}
    for (const [key, value] of Object.entries(state.skills)) {
      if (!key.startsWith(`${slug}/`)) skills[key] = value
    }
    return this.write({ ...state, sources, skills })
  }

  private write(state: StateFile): StateFile {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = join(dirname(this.path), `.${Date.now()}-${process.pid}.state.tmp`)
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    return state
  }
}

/**
 * Whether a source is enabled; an absent entry defaults to enabled.
 * @param state - current state document.
 * @param slug - source slug.
 * @returns the resolved flag.
 */
export function isSourceEnabled(state: StateFile, slug: string): boolean {
  return state.sources[slug]?.enabled !== false
}

/**
 * Whether a skill is enabled; an absent entry defaults to enabled.
 * @param state - current state document.
 * @param source - source slug.
 * @param skillName - skill directory name.
 * @returns the resolved flag.
 */
export function isSkillEnabled(state: StateFile, source: string, skillName: string): boolean {
  return state.skills[skillStateKey(source, skillName)]?.enabled !== false
}

/**
 * Whether a skill is enabled considering its source.
 * @param state - current state document.
 * @param source - source slug.
 * @param skillName - skill directory name.
 * @returns the resolved flag.
 */
export function isSkillVisible(state: StateFile, source: string, skillName: string): boolean {
  return isSourceEnabled(state, source) && isSkillEnabled(state, source, skillName)
}

function emptyState(): StateFile {
  return { version: STATE_VERSION, sources: {}, skills: {} }
}

function normalizeState(value: unknown): StateFile {
  if (typeof value !== 'object' || value === null) return emptyState()
  const record = value as { sources?: unknown; skills?: unknown }
  return {
    version: STATE_VERSION,
    sources: normalizeRecord(record.sources, pruneSourceState),
    skills: normalizeRecord(record.skills, pruneSkillState),
  }
}

function normalizeRecord<T extends object>(
  value: unknown,
  prune: (entry: T) => T | undefined,
): Record<string, T> {
  if (typeof value !== 'object' || value === null) return {}
  const result: Record<string, T> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const pruned = prune(entry as T)
    if (pruned !== undefined) result[key] = pruned
  }
  return result
}

function pruneSourceState(value: SourceState): SourceState | undefined {
  const next: { enabled?: boolean; category?: string; note?: string } = {}
  if (value.enabled === false) next.enabled = false
  const category = text(value.category)
  if (category !== undefined) next.category = category
  const note = text(value.note)
  if (note !== undefined) next.note = note
  return Object.keys(next).length === 0 ? undefined : next
}

function pruneSkillState(value: SkillState): SkillState | undefined {
  const next: { enabled?: boolean; note?: string } = {}
  if (value.enabled === false) next.enabled = false
  const note = text(value.note)
  if (note !== undefined) next.note = note
  return Object.keys(next).length === 0 ? undefined : next
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
