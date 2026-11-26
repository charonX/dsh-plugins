/**
 * Playbook discovery & default compilation utilities:
 * scans workspace `skills/playbooks/*.md` (and ancestor/CLI skill dirs) first,
 * falling back to built-in plugin `playbooks/*.md` so defaults never live in TypeScript code.
 */
import { createHash } from 'node:crypto'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { WORKSPACE_MODES, type DiscoveredPlaybook, type FlowDef, type WorkspaceMode } from './flow-ir.ts'
import { compilePlaybookToFlow, type PlaybookCompileMethod } from './playbook-compiler.ts'
import { discoverWorkspaceSkills, loadSkillMarkdown, type HostSkillsPort } from '../dispatch/workspace-skills.ts'

/** Default workflow Playbook IDs seeded on brand-new installations. */
export const DEFAULT_PLAYBOOK_IDS = ['code-dev', 'bug-fix', 'knowledge-creation', 'refactoring'] as const

const IGNORED_PLAYBOOK_FILES = new Set(['skill.md', 'readme.md'])
const MAX_ANCESTOR_DEPTH = 6

/** Discovered Playbook record with raw Markdown body preserved for host compilation. */
export interface DiscoveredPlaybookEntry extends DiscoveredPlaybook {
  readonly content: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

function normalizePlaybookId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'playbook'
}

function parsePlaybookMeta(content: string, fallbackId: string): {
  readonly id: string
  readonly name: string
  readonly when: string
  readonly workspaceMode: WorkspaceMode
} {
  let id = fallbackId
  let name = fallbackId
  let when = ''
  let workspaceMode: WorkspaceMode = 'in-place'

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (fmMatch?.[1] !== undefined) {
    try {
      const parsed = parseYaml(fmMatch[1]) as Record<string, unknown> | null
      if (parsed !== null && typeof parsed === 'object') {
        if (typeof parsed['id'] === 'string' && parsed['id'].trim() !== '') {
          id = normalizePlaybookId(parsed['id'])
        }
        if (typeof parsed['name'] === 'string' && parsed['name'].trim() !== '') {
          name = parsed['name'].trim()
        }
        const rawWhen = parsed['when'] ?? parsed['description']
        if (typeof rawWhen === 'string' && rawWhen.trim() !== '') {
          when = rawWhen.trim()
        }
        if (
          typeof parsed['workspaceMode'] === 'string'
          && (WORKSPACE_MODES as readonly string[]).includes(parsed['workspaceMode'])
        ) {
          workspaceMode = parsed['workspaceMode'] as WorkspaceMode
        }
      }
    } catch {
      // Malformed frontmatter still falls back gracefully to Markdown body extraction.
    }
  }

  const body = fmMatch === null ? content : content.slice(fmMatch[0].length)
  if (name === fallbackId) {
    const heading = body.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim()
    if (heading !== undefined && heading !== '') name = heading
  }
  if (when === '') {
    const firstParagraph = body
      .split(/\r?\n\r?\n/)
      .map(block => block.trim())
      .find(block => block !== '' && !block.startsWith('#') && !/^\d+\.\s+/.test(block))
    when = (firstParagraph ?? name).replace(/\s+/g, ' ').slice(0, 240)
  }

  return { id, name, when, workspaceMode }
}

/** Resolve the plugin-bundled `playbooks/` fallback directory across source (`src/`) and built (`lib/`) layouts. */
export async function resolveBuiltinPlaybooksDir(): Promise<string | undefined> {
  const candidates = [
    join(import.meta.dirname, '../../playbooks'),
    join(import.meta.dirname, '../playbooks'),
  ]
  for (const dir of candidates) {
    try {
      const info = await stat(dir)
      if (info.isDirectory()) return dir
    } catch {
      // Try next layout candidate.
    }
  }
  return undefined
}

async function existsDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function existsFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function collectPlaybookScanDirs(cwd: string): readonly string[] {
  const dirs: string[] = [
    join(cwd, 'skills', 'playbooks'),
    join(cwd, '.dsh', 'skills', 'playbooks'),
    join(cwd, '.agents', 'skills', 'playbooks'),
    join(cwd, '.claude', 'skills', 'playbooks'),
  ]
  let cursor = dirname(cwd)
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    dirs.push(join(cursor, 'skills', 'playbooks'))
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return dirs
}

async function readPlaybooksFromDir(
  dir: string,
  source: 'workspace' | 'builtin',
  cwd: string | undefined,
  entries: Map<string, DiscoveredPlaybookEntry>,
): Promise<void> {
  if (!(await existsDir(dir))) return
  const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const sortedNames = children
    .filter(child => (child.isFile() || child.isSymbolicLink()) && child.name.toLowerCase().endsWith('.md'))
    .map(child => child.name)
    .filter(name => !IGNORED_PLAYBOOK_FILES.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))

  for (const fileName of sortedNames) {
    const fullPath = join(dir, fileName)
    let content: string
    try {
      content = await readFile(fullPath, 'utf8')
    } catch {
      continue
    }
    const stemId = normalizePlaybookId(fileName)
    const meta = parsePlaybookMeta(content, stemId)
    if (entries.has(meta.id)) continue

    const displayPath = source === 'workspace' && cwd !== undefined
      ? (relative(cwd, fullPath).startsWith('..') ? toPosix(fullPath) : toPosix(relative(cwd, fullPath)))
      : `builtin:${fileName}`
    const portableRef = source === 'workspace'
      ? `skills/playbooks/${fileName}`
      : `builtin:${fileName}`

    entries.set(meta.id, {
      id: meta.id,
      name: meta.name,
      when: meta.when,
      workspaceMode: meta.workspaceMode,
      source,
      ref: portableRef,
      path: displayPath,
      hash: sha256(content),
      content,
    })
  }
}

/**
 * Discover all available Playbook Markdown files.
 * Workspace `skills/playbooks/*.md` (including `.dsh/.agents/.claude` symlinks & ancestor roots)
 * always take precedence over plugin built-in defaults sharing the same `id`.
 */
export async function discoverPlaybooks(cwd?: string): Promise<readonly DiscoveredPlaybookEntry[]> {
  const entries = new Map<string, DiscoveredPlaybookEntry>()
  const resolvedCwd = cwd === undefined || cwd.trim() === '' ? undefined : resolve(cwd)

  if (resolvedCwd !== undefined) {
    for (const dir of collectPlaybookScanDirs(resolvedCwd)) {
      await readPlaybooksFromDir(dir, 'workspace', resolvedCwd, entries)
    }
  }

  const builtinDir = await resolveBuiltinPlaybooksDir()
  if (builtinDir !== undefined) {
    await readPlaybooksFromDir(builtinDir, 'builtin', undefined, entries)
  }

  return [...entries.values()]
}

/** Strip raw Markdown content before sending Playbook catalog metadata across RPC. */
export function toDiscoveredPlaybookView(entry: DiscoveredPlaybookEntry): DiscoveredPlaybook {
  return {
    id: entry.id,
    name: entry.name,
    when: entry.when,
    workspaceMode: entry.workspaceMode,
    source: entry.source,
    ref: entry.ref,
    path: entry.path,
    hash: entry.hash,
  }
}

/**
 * Resolve raw Playbook Markdown for import or incremental hash sync.
 * Supports `builtin:<file>`, portable `skills/playbooks/<file>` workspace overrides,
 * explicit filesystem paths, and host/workspace `SKILL.md` manifests.
 */
export async function loadPlaybookSource(
  kind: 'skill' | 'file',
  ref: string,
  cwd: string | undefined,
  hostSkills?: HostSkillsPort,
): Promise<{ readonly resolvedKind: 'skill' | 'file'; readonly resolvedRef: string; readonly content: string }> {
  const effectiveCwd = cwd ?? process.cwd()
  if (kind === 'skill') {
    const loaded = await loadSkillMarkdown('skill', ref, effectiveCwd, hostSkills)
    return { resolvedKind: 'skill', resolvedRef: ref, content: loaded.content }
  }

  const trimmed = ref.trim()
  const resolvedCwd = cwd === undefined || cwd.trim() === '' ? undefined : resolve(cwd)
  const catalog = await discoverPlaybooks(resolvedCwd)

  // If referencing a managed builtin/portable Playbook (`builtin:x.md` or `skills/playbooks/x.md`),
  // prefer an exact workspace override with the same id when present.
  const normalizedTarget = normalizePlaybookId(basename(trimmed.replace(/^builtin:/i, '')))
  if (trimmed.startsWith('builtin:') || /^skills\/playbooks\/[^/]+\.md$/i.test(toPosix(trimmed))) {
    const match = catalog.find(item => item.id === normalizedTarget || item.ref === trimmed)
    if (match !== undefined) {
      return { resolvedKind: 'file', resolvedRef: match.ref, content: match.content }
    }
  }

  // Try direct file path (absolute or relative to cwd) before matching catalog entries.
  const directCandidates = isAbsolute(trimmed)
    ? [trimmed]
    : resolvedCwd === undefined ? [resolve(trimmed)] : [resolve(resolvedCwd, trimmed)]
  for (const candidate of directCandidates) {
    if (await existsFile(candidate)) {
      return {
        resolvedKind: 'file',
        resolvedRef: trimmed,
        content: await readFile(candidate, 'utf8'),
      }
    }
  }

  const fallback = catalog.find(item => item.id === normalizedTarget || item.ref === trimmed)
  if (fallback !== undefined) {
    return { resolvedKind: 'file', resolvedRef: fallback.ref, content: fallback.content }
  }

  const loaded = await loadSkillMarkdown('file', ref, effectiveCwd, hostSkills)
  return { resolvedKind: 'file', resolvedRef: ref, content: loaded.content }
}

/**
 * Discover and compile default Playbooks into initial `FlowDef[]` for brand-new homes
 * that have neither `team-config.yaml` nor legacy storage-domain records.
 */
export async function discoverAndCompileDefaultPlaybooks(options?: {
  readonly cwd?: string | undefined
  readonly hostSkills?: HostSkillsPort | undefined
  readonly now?: number | undefined
}): Promise<readonly { readonly flow: FlowDef; readonly method: PlaybookCompileMethod }[]> {
  const cwd = options?.cwd
  const effectiveCwd = cwd ?? process.cwd()
  const now = options?.now ?? Date.now()
  const catalog = await discoverPlaybooks(cwd)
  const skills = await discoverWorkspaceSkills(effectiveCwd, options?.hostSkills)
  const availableSkillNames = skills.map(skill => skill.name)

  const byId = new Map(catalog.map(item => [item.id, item]))
  const selected = DEFAULT_PLAYBOOK_IDS
    .map(id => byId.get(id))
    .filter((item): item is DiscoveredPlaybookEntry => item !== undefined)

  const compiled: { readonly flow: FlowDef; readonly method: PlaybookCompileMethod }[] = []
  for (let i = 0; i < selected.length; i += 1) {
    const entry = selected[i]!
    const result = await compilePlaybookToFlow({
      kind: 'file',
      ref: entry.ref,
      content: entry.content,
      flowId: entry.id,
      availableSkillNames,
      now: now + i,
    })
    compiled.push({ flow: result.flow, method: result.method })
  }
  return compiled
}
