/**
 * Unified Skill discovery for Dsh Manager:
 * 1. Scans workspace & ancestor skill directories (`.dsh/skills`, `.agents/skills`,
 *    `.claude/skills`, ancestor `skills/`) for `SKILL.md` manifests.
 * 2. Merges host-registered skills from `ctx.skills.list({ cwd })` (automatically
 *    including `@charonx/dsh-skills-manager` and user-level skill providers).
 * 3. Provides on-demand `loadSkillContent()` for Playbook compilation & display.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { DiscoveredSkill } from '../flow/flow-ir.ts'

export type { DiscoveredSkill }

/** Minimal slice of DSH `ctx.skills` consumed without hard-requiring the service. */
export interface HostSkillsPort {
  list?(options?: { readonly cwd?: string }): Promise<readonly {
    readonly name: string
    readonly description?: string
    readonly path?: string
  }[]>
  get?(name: string, options?: { readonly cwd?: string }): Promise<{
    readonly name: string
    readonly description?: string
    readonly content?: string
    readonly body?: string
    readonly path?: string
  } | undefined>
}

const LOCAL_SKILL_ROOTS = ['.dsh/skills', '.agents/skills', '.claude/skills'] as const
const ANCESTOR_SKILL_ROOTS = ['.dsh/skills', '.agents/skills', '.claude/skills', 'skills'] as const
const MAX_SKILLS = 64
const MAX_ANCESTOR_HOPS = 4

/** Parse `name:` and `description:` from optional YAML frontmatter at the top of `SKILL.md`. */
function parseSkillFrontmatter(text: string, fallbackName: string): { readonly name: string; readonly description: string } {
  const lines = text.split(/\r?\n/, 40)
  if (lines[0]?.trim() !== '---') {
    const firstText = lines.map(line => line.trim()).find(line => line !== '' && !line.startsWith('#')) ?? ''
    return { name: fallbackName, description: firstText.slice(0, 140) }
  }
  let name = fallbackName
  let description = ''
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') break
    const nameMatch = /^name:\s*(.+)$/.exec(line)
    if (nameMatch?.[1] !== undefined) name = stripQuotes(nameMatch[1].trim())
    const descMatch = /^description:\s*(.+)$/.exec(line)
    if (descMatch?.[1] !== undefined) description = stripQuotes(descMatch[1].trim()).slice(0, 140)
  }
  return { name: name || fallbackName, description }
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Scan `<cwd>/.dsh/skills`, `<cwd>/.agents/skills`, `<cwd>/.claude/skills`,
 * ancestor `skills/` directories, and optional host `ctx.skills` for `SKILL.md`
 * manifests. Missing directories or failing providers are skipped quietly.
 */
export async function discoverWorkspaceSkills(
  cwd: string,
  hostSkills?: HostSkillsPort,
): Promise<readonly DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = []
  const seen = new Set<string>()
  const resolvedCwd = resolve(cwd)

  const candidates: { readonly rootDir: string; readonly relDisplay: boolean }[] = []
  for (const relRoot of LOCAL_SKILL_ROOTS) {
    candidates.push({ rootDir: join(resolvedCwd, relRoot), relDisplay: true })
  }
  let cursor = resolvedCwd
  for (let hop = 0; hop <= MAX_ANCESTOR_HOPS; hop += 1) {
    for (const relRoot of ANCESTOR_SKILL_ROOTS) {
      if (hop === 0 && LOCAL_SKILL_ROOTS.includes(relRoot as (typeof LOCAL_SKILL_ROOTS)[number])) continue
      candidates.push({ rootDir: join(cursor, relRoot), relDisplay: hop === 0 })
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }

  for (const candidate of candidates) {
    if (discovered.length >= MAX_SKILLS) break
    let entries
    try {
      entries = await readdir(candidate.rootDir, { withFileTypes: true })
    } catch {
      continue
    }
    const dirs = entries
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort()
    for (const dirName of dirs) {
      if (discovered.length >= MAX_SKILLS) break
      const manifestPath = join(candidate.rootDir, dirName, 'SKILL.md')
      let raw: string
      try {
        raw = await readFile(manifestPath, 'utf8')
      } catch {
        continue
      }
      const meta = parseSkillFrontmatter(raw, dirName)
      if (seen.has(meta.name)) continue
      seen.add(meta.name)
      discovered.push({
        name: meta.name,
        description: meta.description,
        path: candidate.relDisplay ? relative(resolvedCwd, manifestPath) : manifestPath,
        source: 'workspace',
      })
    }
  }

  if (hostSkills?.list !== undefined && discovered.length < MAX_SKILLS) {
    try {
      const hostEntries = await hostSkills.list({ cwd: resolvedCwd })
      for (const entry of hostEntries) {
        if (discovered.length >= MAX_SKILLS) break
        if (seen.has(entry.name)) continue
        seen.add(entry.name)
        discovered.push({
          name: entry.name,
          description: (entry.description ?? '').slice(0, 140),
          path: entry.path ?? `ctx.skills:${entry.name}`,
          source: 'host',
        })
      }
    } catch {
      // Host skill discovery failure must never break dispatch.
    }
  }

  return discovered
}

/** Resolve the full Markdown content of one skill or playbook by name or path. */
export async function loadSkillMarkdown(
  kind: 'skill' | 'file',
  ref: string,
  cwd: string,
  hostSkills?: HostSkillsPort,
): Promise<{ readonly content: string; readonly resolvedRef: string }> {
  if (kind === 'file') {
    const absPath = resolve(cwd, ref)
    const content = await readFile(absPath, 'utf8')
    return { content, resolvedRef: absPath }
  }
  const discovered = await discoverWorkspaceSkills(cwd, hostSkills)
  const hit = discovered.find(entry => entry.name === ref)
  if (hit !== undefined && !hit.path.startsWith('ctx.skills:')) {
    const absPath = resolve(cwd, hit.path)
    const content = await readFile(absPath, 'utf8')
    return { content, resolvedRef: hit.path }
  }
  if (hostSkills?.get !== undefined) {
    const def = await hostSkills.get(ref, { cwd: resolve(cwd) })
    const body = def?.content ?? def?.body
    if (body !== undefined && body !== '') {
      return { content: body, resolvedRef: def?.path ?? ref }
    }
  }
  throw new Error(`skill "${ref}" not found in workspace or host registry`)
}

/** Format discovered skills into concise prompt lines, highlighting step-mounted skills first. */
export function formatSkillPromptLines(
  skills: readonly DiscoveredSkill[],
  mountedSkillNames: readonly string[] = [],
): readonly string[] {
  const mountedSet = new Set(mountedSkillNames)
  const lines: string[] = []
  if (mountedSkillNames.length > 0) {
    lines.push('Required step skills (read and follow each matching SKILL.md before executing):')
    for (const name of mountedSkillNames) {
      const hit = skills.find(skill => skill.name === name)
      if (hit !== undefined) {
        lines.push(hit.description !== ''
          ? `- ${hit.name} (${hit.path}): ${hit.description}`
          : `- ${hit.name} (${hit.path})`)
      } else {
        lines.push(`- ${name} (invoke or read skill "${name}" if available in your skill catalog)`)
      }
    }
  }
  const extra = skills.filter(skill => !mountedSet.has(skill.name))
  if (extra.length > 0) {
    lines.push(mountedSkillNames.length > 0
      ? 'Other available skills (read matching SKILL.md if helpful):'
      : 'Available skills (read matching SKILL.md when relevant):')
    for (const skill of extra) {
      lines.push(skill.description !== ''
        ? `- ${skill.name} (${skill.path}): ${skill.description}`
        : `- ${skill.name} (${skill.path})`)
    }
  }
  return lines
}
