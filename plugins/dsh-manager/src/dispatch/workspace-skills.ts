/**
 * Dynamic workspace skill discovery for external CLI and built-in executors
 * (Multica-style workspace context injection): scans standard `.agents/skills`,
 * `.claude/skills`, and ancestor `skills/` directories for `SKILL.md`
 * manifests and returns compact prompt references without reading full bodies.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

/** One discovered skill manifest inside a workspace. */
export interface DiscoveredSkill {
  readonly name: string
  readonly description: string
  readonly path: string
}

const LOCAL_SKILL_ROOTS = ['.agents/skills', '.claude/skills'] as const
const ANCESTOR_SKILL_ROOTS = ['.agents/skills', '.claude/skills', 'skills'] as const
const MAX_SKILLS = 16
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
 * Scan `<cwd>/.agents/skills`, `<cwd>/.claude/skills`, and ancestor skill
 * directories (such as a parent Home Repo `skills/`) for `SKILL.md` manifests.
 * Missing directories or unreadable files are skipped quietly.
 */
export async function discoverWorkspaceSkills(cwd: string): Promise<readonly DiscoveredSkill[]> {
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
      })
    }
  }
  return discovered
}

/** Format discovered workspace skills into concise prompt instructions. */
export function formatSkillPromptLines(skills: readonly DiscoveredSkill[]): readonly string[] {
  if (skills.length === 0) return []
  return [
    'Workspace skills available (read matching SKILL.md when relevant):',
    ...skills.map(skill => skill.description !== ''
      ? `- ${skill.name} (${skill.path}): ${skill.description}`
      : `- ${skill.name} (${skill.path})`),
  ]
}
