/**
 * SKILL.md frontmatter parsing with the harness's skill-name and invocation
 * rules.
 *
 * Parsing never throws: a malformed file yields a `problem` so the manager UI
 * can show it, while the skill provider skips it.
 *
 * @module dsh-skills-manager/frontmatter
 */

import { parse as parseYaml } from 'yaml'
import type { SkillInvocationPolicy } from './shared/api.js'

/** Parsed result of one SKILL.md file. */
export interface ParsedSkillFile {
  /** Catalog name from frontmatter, absent when the file is invalid. */
  readonly name?: string
  /** Routing description from frontmatter. */
  readonly description?: string
  /** Optional extra routing guidance from frontmatter. */
  readonly whenToUse?: string
  /** Resolved invocation controls; defaults permit both surfaces. */
  readonly invocation: SkillInvocationPolicy
  /** Instruction body with the frontmatter block removed. */
  readonly content: string
  /** Why the file cannot contribute a skill; absent when it is valid. */
  readonly problem?: string
}

/** Frontmatter block: `---` line, YAML, closing `---` line, then the body. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u

const DEFAULT_INVOCATION: SkillInvocationPolicy = { modelInvocable: true, userInvocable: true }

/** Harness skill-name grammar (kebab-case). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Whether a name is a valid skill name.
 * @param name - candidate catalog name.
 * @returns whether the name matches the harness grammar.
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/**
 * Parse one SKILL.md text.
 * @param text - raw file contents.
 * @returns the parsed skill, or the reason it cannot be used.
 */
export function parseSkillMarkdown(text: string): ParsedSkillFile {
  const match = FRONTMATTER.exec(text)
  if (match === null) {
    return { invocation: DEFAULT_INVOCATION, content: '', problem: 'SKILL.md has no YAML frontmatter block' }
  }
  let data: unknown
  try {
    data = parseYaml(match[1] ?? '')
  } catch (error) {
    return { invocation: DEFAULT_INVOCATION, content: '', problem: `invalid YAML frontmatter: ${errorMessage(error)}` }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { invocation: DEFAULT_INVOCATION, content: '', problem: 'frontmatter must be a YAML mapping' }
  }
  const record = data as Record<string, unknown>
  const name = stringField(record, 'name')
  const description = stringField(record, 'description')
  if (name === undefined || description === undefined) {
    return {
      invocation: DEFAULT_INVOCATION,
      content: '',
      problem: 'frontmatter requires non-empty "name" and "description"',
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
    }
  }
  if (!isSkillName(name)) {
    return {
      invocation: DEFAULT_INVOCATION,
      content: '',
      problem: `invalid skill name "${name}" (kebab-case required)`,
      name,
      description,
    }
  }
  let invocation: SkillInvocationPolicy
  try {
    invocation = parseInvocationPolicy(record)
  } catch (error) {
    return { invocation: DEFAULT_INVOCATION, content: '', problem: errorMessage(error), name, description }
  }
  const whenToUse = stringField(record, 'whenToUse')
  return {
    invocation,
    content: (match[2] ?? '').trim(),
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
  }
}

function parseInvocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new Error(`frontmatter field "${key}" must be a boolean`)
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
