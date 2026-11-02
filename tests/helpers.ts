/**
 * Shared fixtures for the manager's unit tests.
 *
 * @module dsh-skills-manager/tests/helpers
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A temporary directory that is removed by {@link cleanup}. */
export interface TempTree {
  readonly root: string
  /** Resolve a path below the temporary root. */
  path: (...segments: string[]) => string
  /** Remove the tree. */
  cleanup(): void
}

/**
 * Create an empty temporary tree.
 * @returns the tree handle.
 */
export function tempTree(): TempTree {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skills-manager-'))
  return {
    root,
    path: (...segments: string[]) => join(root, ...segments),
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  }
}

/**
 * Write one SKILL.md with the given frontmatter fields and body.
 * @param dir - skill directory, created when missing.
 * @param fields - literal frontmatter lines.
 * @param body - instruction body.
 */
export function writeSkill(dir: string, fields: readonly string[], body = 'Do the thing.'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${fields.join('\n')}\n---\n\n${body}\n`, 'utf8')
}

/** Default frontmatter for a valid skill. */
export function skillFields(name: string, description = `The ${name} skill.`): string[] {
  return [`name: ${name}`, `description: ${description}`]
}

/**
 * Read a JSON response body in tests.
 * @param response - fetch response.
 * @returns the parsed body.
 */
export async function jsonBody<T>(response: Response): Promise<T> {
  return await response.json() as T
}
