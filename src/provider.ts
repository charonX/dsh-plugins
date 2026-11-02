/**
 * `ctx.skills` provider backed by the managed library.
 *
 * The provider reads the library on every observation: the registry caches a
 * completed catalog until the manager invalidates it, and external edits become
 * visible on the next invalidation or restart.
 *
 * @module dsh-skills-manager/provider
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillSource,
} from '@deepseek-ai/dsh-skill'
import { parseSkillMarkdown } from './frontmatter.js'
import { scanLibrary, type ScannedSource, type WarnLogger } from './library.js'
import { isSkillVisible, type StateFile } from './state.js'

/** Origin bucket reported for every skill this provider owns. */
export const MANAGED_SKILL_SOURCE: SkillSource = 'skills-manager'

/** Provider options resolved by the plugin. */
export interface ProviderOptions {
  /** Absolute library root. */
  readonly libraryDir: string
  /** Provider name registered on `ctx.skills`. */
  readonly providerName: string
  /** Precedence rank among providers; lower wins. */
  readonly rank: number
  /** Reads the current manager state. */
  readonly readState: () => StateFile
  /** Receives warnings for invalid or duplicate skills. */
  readonly logger: WarnLogger
}

/** Locator handed back to {@link LibrarySkillProvider.get}. */
interface SkillLocator {
  readonly dir: string
  readonly name: string
}

/**
 * Provider that maps library sources into `ctx.skills`.
 */
export class LibrarySkillProvider implements SkillProvider {
  readonly name: string

  /**
   * @param options - resolved provider options.
   * @param control - registration-scoped invalidation capability.
   */
  constructor(
    private readonly options: ProviderOptions,
    private readonly control: SkillProviderControl,
  ) {
    this.name = options.providerName
  }

  /**
   * List enabled, valid skills from every source.
   * @param lookup - caller context; unused beyond cancellation.
   * @returns provider candidates.
   */
  async list(lookup: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    lookup.signal?.throwIfAborted()
    const state = this.options.readState()
    const candidates: SkillCandidate[] = []
    const owners = new Map<string, string>()
    for (const source of scanLibrary(this.options.libraryDir, this.options.logger)) {
      lookup.signal?.throwIfAborted()
      collectCandidates(source, state, this, this.options, candidates, owners)
    }
    return candidates
  }

  /**
   * Load one skill body by rereading its `SKILL.md`.
   * @param candidate - winning candidate returned by {@link list}.
   * @param lookup - caller context; unused beyond cancellation.
   * @returns the complete definition, or undefined when the skill is gone or invalid.
   */
  async get(candidate: SkillCandidate, lookup: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    lookup.signal?.throwIfAborted()
    const locator = readLocator(candidate.locator)
    if (locator === undefined) return undefined
    let text: string
    try {
      text = readFileSync(join(locator.dir, 'SKILL.md'), 'utf8')
    } catch {
      return undefined
    }
    const parsed = parseSkillMarkdown(text)
    if (parsed.problem !== undefined || parsed.name === undefined || parsed.description === undefined) return undefined
    if (parsed.name !== candidate.name) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      invocation: parsed.invocation,
      source: MANAGED_SKILL_SOURCE,
      provider: this.name,
      content: parsed.content,
      path: join(locator.dir, 'SKILL.md'),
      resourceBase: { kind: 'directory', path: locator.dir },
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    }
  }

  /**
   * Invalidate the registry's completed catalog for this provider.
   */
  invalidate(): void {
    this.control.invalidate()
  }
}

function collectCandidates(
  source: ScannedSource,
  state: StateFile,
  provider: LibrarySkillProvider,
  options: ProviderOptions,
  candidates: SkillCandidate[],
  owners: Map<string, string>,
): void {
  for (const skill of source.skills) {
    if (!skill.valid || skill.name === undefined || skill.description === undefined) continue
    if (!isSkillVisible(state, source.slug, skill.skillName)) continue
    const owner = owners.get(skill.name)
    if (owner !== undefined) {
      options.logger.warn(
        `skills-manager: ${source.slug}/${skill.skillName} ignored: skill name "${skill.name}" already provided by ${owner}`,
      )
      continue
    }
    owners.set(skill.name, `${source.slug}/${skill.skillName}`)
    const locator: SkillLocator = { dir: skill.dir, name: skill.name }
    candidates.push({
      name: skill.name,
      description: skill.description,
      invocation: skill.invocation,
      source: MANAGED_SKILL_SOURCE,
      provider: provider.name,
      rank: options.rank,
      path: join(skill.dir, 'SKILL.md'),
      resourceBase: { kind: 'directory', path: skill.dir },
      locator,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    })
  }
}

function readLocator(value: unknown): SkillLocator | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { dir?: unknown; name?: unknown }
  if (typeof record.dir !== 'string' || typeof record.name !== 'string') return undefined
  return { dir: record.dir, name: record.name }
}
