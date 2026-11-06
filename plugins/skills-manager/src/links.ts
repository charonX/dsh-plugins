/**
 * Project distribution: symlinks from a project's agent skills directories
 * straight into the managed library.
 *
 * Disk is the truth for what a project sees. A small record file remembers the
 * *intent* per project — which skills were asked for and which agents were
 * targeted — because a deleted link leaves no trace to repair from.
 *
 * Only symlinks this manager can attribute to the library are ever removed.
 * A real directory, a file, or a symlink pointing elsewhere is reported as a
 * conflict and left untouched.
 *
 * @module dsh-skills-manager/links
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { AGENT_TARGETS, DEFAULT_AGENT_TARGET, findAgentTarget, type AgentTarget } from './agent-registry.js'
import { SkillManagerError } from './errors.js'
import { scanLibrary, type ScannedSource, type WarnLogger } from './library.js'
import { canonicalPath, isInsideOrEqual } from './paths.js'
import type { LinkEntryView, LinkReport, LinkTargetView, ProjectLinkView } from './shared/api.js'
import { isSkillEnabled, isSourceEnabled, type StateFile } from './state.js'

/** One recorded association. */
interface LinkEntry {
  readonly source: string
  readonly skillName: string
  /** Project switch; absent means enabled. */
  readonly enabled?: boolean
}

/** One project record. */
interface ProjectRecord {
  readonly agents: string[]
  readonly entries: LinkEntry[]
}

/** On-disk record document. */
interface LinkFile {
  readonly version: 1
  readonly projects: Record<string, ProjectRecord>
}

/** Link manager inputs resolved by the plugin. */
export interface LinkManagerOptions {
  /** Absolute library root. */
  readonly libraryDir: string
  /** Absolute record file path. */
  readonly recordPath: string
  /** Receives warnings that must not fail an operation. */
  readonly logger: WarnLogger
  /** Reads the current manager state. */
  readonly readState: () => StateFile
}

/** Resolved target directory shared by one or more agents. */
interface TargetDir {
  readonly dir: string
  readonly skillsDir: string
  readonly agents: string[]
}

/** Values a link request must provide. */
export interface LinkRequest {
  /** Absolute project directory. */
  readonly project: string
  /** Source slug. */
  readonly source: string
  /** One skill of the source; omitted links every enabled skill of the source. */
  readonly skillName?: string | undefined
  /** Agent keys to target; omitted keeps the project's recorded agents. */
  readonly agents?: readonly string[] | undefined
}

const STATE_VERSION = 1
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/** Project distribution service. */
export class LinkManager {
  /**
   * @param options - resolved library, record, state, and logger dependencies.
   */
  constructor(private readonly options: LinkManagerOptions) {}

  /**
   * Read every recorded project, refreshed from disk.
   * @returns one view per recorded project, sorted by path.
   */
  listProjects(): ProjectLinkView[] {
    const file = this.readFile()
    return Object.keys(file.projects)
      .sort((left, right) => left.localeCompare(right))
      .map((project) => this.view(project, file))
  }

  /**
   * Link one skill, or every enabled skill of a source, into a project.
   * @param request - project, source, optional skill, and agent targets.
   * @returns the refreshed project view and per-state counts.
   * @throws {SkillManagerError} for an unusable project, unknown source, disabled skill, or occupied positions.
   */
  link(request: LinkRequest): LinkReport {
    const project = validateProject(request.project, this.options.libraryDir)
    const file = this.readFile()
    const record = file.projects[project]
    const agents = resolveAgents(request.agents, record?.agents)
    const entries = this.entriesToLink(request)
    const targets = targetDirs(project, agents)
    for (const entry of entries) {
      const skillDir = this.skillDirectory(entry.source, entry.skillName)
      for (const target of targets) this.placeLink(target, entry.skillName, skillDir)
    }
    this.writeFile({
      ...file,
      projects: {
        ...file.projects,
        [project]: {
          agents: union(record?.agents ?? [], agents),
          entries: mergeEntries(record?.entries ?? [], entries),
        },
      },
    })
    return this.report(project)
  }

  /**
   * Remove links this manager placed for one skill or a whole source.
   * @param request - project, source, optional skill, and optional agent subset.
   * @returns the refreshed project view and per-state counts.
   */
  unlink(request: LinkRequest): LinkReport {
    const project = validateProject(request.project, this.options.libraryDir)
    const file = this.readFile()
    const record = file.projects[project]
    if (record === undefined) {
      throw new SkillManagerError(404, 'NOT_FOUND', `No linked skills recorded for ${project}`)
    }
    const agents = request.agents === undefined ? record.agents : validateAgents(request.agents)
    const sourceDir = join(this.options.libraryDir, request.source)
    for (const target of targetDirs(project, agents)) {
      removeLinksInto(target.dir, sourceDir, request.skillName)
    }
    const entries = record.entries.filter((entry) =>
      entry.source !== request.source
      || (request.skillName !== undefined && entry.skillName !== request.skillName))
    this.writeFile(entries.length === 0
      ? withoutProject(file, project)
      : { ...file, projects: { ...file.projects, [project]: { agents: record.agents, entries } } })
    return this.report(project)
  }

  /**
   * Rebuild every recorded association for a project.
   * @param projectInput - absolute project directory.
   * @returns the refreshed project view and per-state counts;
   *   an unrecorded project yields an empty view.
   */
  resync(projectInput: string): LinkReport {
    const project = validateProject(projectInput, this.options.libraryDir)
    const file = this.readFile()
    const record = file.projects[project]
    if (record === undefined) return this.report(project)
    const live = record.entries.filter((entry) => this.skillDirectoryIfPresent(entry) !== undefined)
    const targets = targetDirs(project, record.agents)
    for (const entry of live.filter((candidate) => candidate.enabled !== false)) {
      const skillDir = this.skillDirectory(entry.source, entry.skillName)
      for (const target of targets) this.repairOrPlace(join(target.dir, entry.skillName), skillDir)
    }
    this.writeFile({
      ...file,
      projects: { ...file.projects, [project]: { agents: record.agents, entries: live } },
    })
    return this.report(project)
  }

  /**
   * Turn this project's distribution of a skill (or a whole source) on or off.
   * Disabling removes the symlinks but keeps the record; enabling validates the
   * skill and recreates the links.
   * @param request - project, source, optional skill, and the desired switch.
   * @returns the refreshed project view and per-state counts.
   */
  setEnabled(request: LinkRequest & { readonly enabled: boolean }): LinkReport {
    const project = validateProject(request.project, this.options.libraryDir)
    const file = this.readFile()
    const record = file.projects[project]
    if (record === undefined) {
      throw new SkillManagerError(404, 'NOT_FOUND', `No linked skills recorded for ${project}`)
    }
    const matches = record.entries.filter((entry) => matchesRequest(entry, request))
    if (matches.length === 0) {
      throw new SkillManagerError(404, 'NOT_FOUND', 'No recorded link matches this request')
    }
    const sourceDir = join(this.options.libraryDir, request.source)
    if (request.enabled) {
      const state = this.options.readState()
      if (!isSourceEnabled(state, request.source)) {
        throw new SkillManagerError(409, 'SKILL_SOURCE_DISABLED', `Source "${request.source}" is disabled; enable it before distributing it`)
      }
      for (const entry of matches) {
        if (!isSkillEnabled(state, request.source, entry.skillName)) {
          throw new SkillManagerError(409, 'SKILL_DISABLED', `Skill "${entry.skillName}" is disabled; enable it before distributing it`)
        }
        const skillDir = this.skillDirectory(entry.source, entry.skillName)
        for (const target of targetDirs(project, record.agents)) this.placeLink(target, entry.skillName, skillDir)
      }
    } else {
      for (const entry of matches) {
        for (const target of targetDirs(project, record.agents)) {
          removeLinksInto(target.dir, sourceDir, entry.skillName)
        }
      }
    }
    this.writeFile({
      ...file,
      projects: {
        ...file.projects,
        [project]: {
          agents: record.agents,
          entries: record.entries.map((entry) =>
            matchesRequest(entry, request) ? { ...entry, enabled: request.enabled } : entry),
        },
      },
    })
    return this.report(project)
  }

  /**
   * Remove links of a source (or skill) from every project while keeping the
   * records, so a later restore can recreate them.
   * @param source - source slug.
   * @param skillName - optional single skill.
   */
  detach(source: string, skillName?: string): void {
    const sourceDir = join(this.options.libraryDir, source)
    for (const project of Object.keys(this.readFile().projects)) {
      const record = this.readFile().projects[project]
      /* v8 ignore next -- projects come from the same snapshot */
      if (record === undefined) continue
      for (const target of targetDirs(project, record.agents)) {
        for (const entry of record.entries) {
          if (entry.source !== source || (skillName !== undefined && entry.skillName !== skillName)) continue
          removeLinksInto(target.dir, sourceDir, entry.skillName)
        }
      }
    }
  }

  /**
   * Recreate links for a source (or skill) in every project whose entry is
   * enabled and whose skill is currently usable.
   * @param source - source slug.
   * @param skillName - optional single skill.
   */
  restore(source: string, skillName?: string): void {
    const state = this.options.readState()
    if (!isSourceEnabled(state, source)) return
    const file = this.readFile()
    for (const [project, record] of Object.entries(file.projects)) {
      for (const entry of record.entries) {
        if (entry.source !== source || entry.enabled === false) continue
        if (skillName !== undefined && entry.skillName !== skillName) continue
        if (!isSkillEnabled(state, source, entry.skillName)) continue
        const skillDir = this.skillDirectoryIfPresent(entry)
        if (skillDir === undefined) continue
        for (const target of targetDirs(project, record.agents)) {
          this.repairOrPlace(join(target.dir, entry.skillName), skillDir)
        }
      }
    }
  }

  /**
   * Remove every link resolving into a source, across all recorded projects,
   * and drop the records. Called before the source directory is deleted so no
   * dangling link remains.
   * @param source - source slug being removed.
   */
  forgetSource(source: string): void {
    this.forget((entry) => entry.source === source, join(this.options.libraryDir, source))
  }

  /**
   * Remove links of one skill, across all recorded projects.
   * @param source - source slug.
   * @param skillName - skill directory name that is being disabled or removed.
   */
  forgetSkill(source: string, skillName: string): void {
    this.forget((entry) => entry.source === source && entry.skillName === skillName, join(this.options.libraryDir, source))
  }

  private forget(match: (entry: LinkEntry) => boolean, sourceDir: string): void {
    const file = this.readFile()
    const projects = { ...file.projects }
    let changed = false
    for (const [project, record] of Object.entries(file.projects)) {
      const removed = record.entries.filter((entry) => match(entry))
      if (removed.length === 0) continue
      changed = true
      for (const target of targetDirs(project, record.agents)) {
        for (const entry of removed) removeLinksInto(target.dir, sourceDir, entry.skillName)
      }
      const entries = record.entries.filter((entry) => !match(entry))
      if (entries.length === 0) delete projects[project]
      else projects[project] = { agents: record.agents, entries }
    }
    if (changed) this.writeFile({ ...file, projects })
  }

  private report(project: string): LinkReport {
    const view = this.view(project, this.readFile())
    const counts = { linked: 0, missing: 0, broken: 0, conflict: 0, external: 0 }
    for (const target of view.targets) counts[target.state] += 1
    return { project: view, counts }
  }

  private view(project: string, file: LinkFile): ProjectLinkView {
    const record = file.projects[project]
    const agents = record?.agents ?? []
    const recordedEntries = record?.entries ?? []
    const exists = isDirectory(project)
    const live = recordedEntries.filter((entry) => this.skillDirectoryIfPresent(entry) !== undefined)
    const stale = recordedEntries.filter((entry) => this.skillDirectoryIfPresent(entry) === undefined)
    const targets: LinkTargetView[] = []
    const dirs = exists ? targetDirs(project, agents) : []
    for (const entry of live.filter((candidate) => candidate.enabled !== false)) {
      const skillDir = this.skillDirectory(entry.source, entry.skillName)
      for (const target of dirs) {
        targets.push(observeLink(join(target.dir, entry.skillName), skillDir, target, entry.skillName, this.options.libraryDir, entry.source))
      }
    }
    if (exists) {
      const recordedPaths = new Set(targets.map((target) => target.path))
      for (const target of dirs) {
        for (const name of listDirectoryNames(target.dir)) {
          const linkPath = join(target.dir, name)
          if (recordedPaths.has(linkPath)) continue
          const observed = observeLink(linkPath, undefined, target, name, this.options.libraryDir)
          if (observed.state === 'external' || observed.state === 'conflict' || observed.state === 'broken') {
            targets.push(observed)
          }
        }
      }
    }
    const entries: LinkEntryView[] = recordedEntries.map((entry) => ({
      source: entry.source,
      skillName: entry.skillName,
      enabled: entry.enabled !== false,
    }))
    return {
      project,
      exists,
      agents,
      entries,
      targets,
      stale: stale.map((entry) => ({
        source: entry.source,
        skillName: entry.skillName,
        enabled: entry.enabled !== false,
      })),
    }
  }

  private entriesToLink(request: LinkRequest): LinkEntry[] {
    const source = this.scannedSource(request.source)
    const state = this.options.readState()
    if (!isSourceEnabled(state, request.source)) {
      throw new SkillManagerError(409, 'SKILL_SOURCE_DISABLED', `Source "${request.source}" is disabled; enable it before linking`)
    }
    if (request.skillName !== undefined) {
      const skill = source.skills.find((candidate) => candidate.skillName === request.skillName)
      if (skill === undefined) {
        throw new SkillManagerError(404, 'NOT_FOUND', `Unknown skill: ${request.source}/${request.skillName}`)
      }
      if (!skill.valid) {
        throw new SkillManagerError(409, 'SKILL_INVALID', `Skill "${request.skillName}" is invalid: ${skill.problem ?? 'unknown reason'}`)
      }
      if (!isSkillEnabled(state, request.source, request.skillName)) {
        throw new SkillManagerError(409, 'SKILL_DISABLED', `Skill "${request.skillName}" is disabled; enable it before linking`)
      }
      return [{ source: request.source, skillName: request.skillName }]
    }
    const entries = source.skills
      .filter((skill) => skill.valid && isSkillEnabled(state, request.source, skill.skillName))
      .map((skill) => ({ source: request.source, skillName: skill.skillName }))
    if (entries.length === 0) {
      throw new SkillManagerError(409, 'SKILL_SOURCE_EMPTY', `Source "${request.source}" has no enabled valid skill to link`)
    }
    return entries
  }

  private scannedSource(source: string): ScannedSource {
    const found = scanLibrary(this.options.libraryDir, this.options.logger)
      .find((candidate) => candidate.slug === source)
    if (found === undefined) throw new SkillManagerError(404, 'NOT_FOUND', `Unknown skill source: ${source}`)
    return found
  }

  private skillDirectory(source: string, skillName: string): string {
    const dir = this.skillDirectoryIfPresent({ source, skillName })
    if (dir === undefined) throw new SkillManagerError(404, 'NOT_FOUND', `Unknown skill: ${source}/${skillName}`)
    return dir
  }

  private skillDirectoryIfPresent(entry: LinkEntry): string | undefined {
    const source = scanLibrary(this.options.libraryDir, this.options.logger)
      .find((candidate) => candidate.slug === entry.source)
    const skill = source?.skills.find((candidate) => candidate.skillName === entry.skillName)
    return skill === undefined || !skill.valid ? undefined : skill.dir
  }

  private placeLink(target: TargetDir, skillName: string, skillDir: string): void {
    const linkPath = join(target.dir, skillName)
    const observed = observeLink(linkPath, skillDir, target, skillName, this.options.libraryDir)
    if (observed.state === 'linked') return
    if (observed.state !== 'missing') {
      this.options.logger.warn(`skills-manager: ${linkPath} left untouched: ${observed.problem ?? observed.state}`)
      return
    }
    createLink(skillDir, linkPath)
  }

  private repairOrPlace(linkPath: string, skillDir: string): void {
    const existing = lstatSync(linkPath, { throwIfNoEntry: false })
    if (existing === undefined) {
      createLink(skillDir, linkPath)
      return
    }
    if (!existing.isSymbolicLink()) return
    let real: string
    try {
      real = realpathSync(linkPath)
    } catch {
      // A dangling link into the library is ours to repair.
      const intended = resolveLinkTarget(linkPath)
      if (intended !== undefined && isInsideOrEqual(canonicalPath(this.options.libraryDir), canonicalPath(intended))) {
        rmSync(linkPath, { force: true })
        createLink(skillDir, linkPath)
      }
      return
    }
    if (canonicalPath(real) === canonicalPath(skillDir)) return
    // A library-owned link whose name is the intended skill was repointed by
    // hand; restore it. Foreign links and external directories stay untouched.
    if (isInsideOrEqual(canonicalPath(this.options.libraryDir), canonicalPath(real))) {
      rmSync(linkPath, { force: true })
      createLink(skillDir, linkPath)
    }
  }

  private readFile(): LinkFile {
    let raw: string
    try {
      raw = readFileSync(this.options.recordPath, 'utf8')
    } catch {
      return emptyLinkFile()
    }
    try {
      return normalizeLinkFile(JSON.parse(raw) as unknown)
    } catch (error) {
      this.options.logger.warn(`skills-manager: ignoring unreadable link record ${this.options.recordPath}: ${message(error)}`)
      return emptyLinkFile()
    }
  }

  private writeFile(file: LinkFile): void {
    mkdirSync(dirname(this.options.recordPath), { recursive: true })
    const temporary = join(dirname(this.options.recordPath), `.${Date.now()}-${process.pid}.links.tmp`)
    try {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.options.recordPath)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

/**
 * Registry rows exposed to the Web Client.
 * @returns agent conventions with DSH first.
 */
export function listAgentTargets(): readonly AgentTarget[] {
  return AGENT_TARGETS
}

function validateProject(input: string, libraryDir: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new SkillManagerError(400, 'PROJECT_INVALID', 'A project must be an absolute directory path')
  }
  const expanded = expandHomePath(input.trim())
  if (!isAbsolute(expanded)) {
    throw new SkillManagerError(400, 'PROJECT_INVALID', 'A project must be an absolute directory path')
  }
  const project = resolve(expanded)
  if (!isDirectory(project)) {
    throw new SkillManagerError(400, 'PROJECT_INVALID', `Project directory does not exist: ${project}`)
  }
  if (isInsideOrEqual(canonicalPath(libraryDir), canonicalPath(project))
    || isInsideOrEqual(canonicalPath(project), canonicalPath(libraryDir))) {
    throw new SkillManagerError(400, 'PROJECT_INVALID', 'A project must not equal, contain, or live inside the skill library')
  }
  return project
}

function validateAgents(requested: readonly string[]): string[] {
  const keys = [...new Set(requested)]
  if (keys.length === 0) throw new SkillManagerError(400, 'AGENT_INVALID', 'At least one agent target is required')
  for (const key of keys) {
    if (findAgentTarget(key) === undefined) {
      throw new SkillManagerError(400, 'AGENT_INVALID', `Unknown agent target: ${key}`)
    }
  }
  return keys
}

function resolveAgents(requested: readonly string[] | undefined, recorded: readonly string[] | undefined): string[] {
  if (requested !== undefined) return validateAgents(requested)
  if (recorded !== undefined && recorded.length > 0) return [...recorded]
  return [DEFAULT_AGENT_TARGET]
}

function targetDirs(project: string, agents: readonly string[]): TargetDir[] {
  const byDir = new Map<string, TargetDir>()
  for (const key of agents) {
    const agent = findAgentTarget(key)
    if (agent === undefined) continue
    const skillsDir = agent.skillsDir.replace(/\\/gu, '/')
    if (isAbsolute(skillsDir) || relative('.', skillsDir).startsWith('..')) continue
    const dir = join(project, ...skillsDir.split('/'))
    const existing = byDir.get(dir)
    if (existing === undefined) byDir.set(dir, { dir, skillsDir, agents: [key] })
    else existing.agents.push(key)
  }
  return [...byDir.values()]
}

function observeLink(
  linkPath: string,
  expectedTarget: string | undefined,
  target: TargetDir,
  skillName: string,
  libraryDir: string,
  source?: string,
): LinkTargetView {
  const base = {
    agents: target.agents,
    skillsDir: target.skillsDir,
    skillName,
    path: linkPath,
    ...(source === undefined ? {} : { source }),
  }
  const existing = lstatSync(linkPath, { throwIfNoEntry: false })
  if (existing === undefined) {
    return expectedTarget === undefined
      ? { ...base, state: 'external', problem: 'missing' }
      : { ...base, state: 'missing', target: expectedTarget }
  }
  if (!existing.isSymbolicLink()) {
    return { ...base, state: 'conflict', problem: 'a real file or directory occupies this position' }
  }
  let real: string
  try {
    real = realpathSync(linkPath)
  } catch {
    const intended = resolveLinkTarget(linkPath)
    return {
      ...base,
      state: 'broken',
      problem: 'the link target no longer exists',
      ...(intended === undefined ? {} : { target: intended }),
    }
  }
  if (expectedTarget !== undefined && canonicalPath(real) === canonicalPath(expectedTarget)) {
    return { ...base, state: 'linked', target: real }
  }
  if (isInsideOrEqual(canonicalPath(libraryDir), canonicalPath(real))) {
    return { ...base, state: 'external', target: real, problem: 'this link points at another library skill' }
  }
  return { ...base, state: 'external', target: real, problem: 'a foreign symlink occupies this position' }
}

function createLink(target: string, linkPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    symlinkSync(target, linkPath, LINK_TYPE)
  } catch (error) {
    throw new SkillManagerError(500, 'LINK_FAILED', `Cannot create ${linkPath}: ${message(error)}`)
  }
}

function removeLinksInto(dir: string, sourceDir: string, skillName: string | undefined): void {
  if (!isDirectory(dir)) return
  for (const name of listDirectoryNames(dir)) {
    if (skillName !== undefined && name !== skillName) continue
    const linkPath = join(dir, name)
    const existing = lstatSync(linkPath, { throwIfNoEntry: false })
    if (existing === undefined || !existing.isSymbolicLink()) continue
    const intended = resolveLinkTarget(linkPath)
    if (intended === undefined) continue
    if (isInsideOrEqual(canonicalPath(sourceDir), canonicalPath(intended))) rmSync(linkPath, { force: true })
  }
}

function resolveLinkTarget(linkPath: string): string | undefined {
  try {
    return resolve(dirname(linkPath), readlinkSync(linkPath))
  } catch {
    return undefined
  }
}

function listDirectoryNames(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function emptyLinkFile(): LinkFile {
  return { version: STATE_VERSION, projects: {} }
}

function normalizeLinkFile(value: unknown): LinkFile {
  if (typeof value !== 'object' || value === null) return emptyLinkFile()
  const record = value as { projects?: unknown }
  if (typeof record.projects !== 'object' || record.projects === null) return emptyLinkFile()
  const projects: Record<string, ProjectRecord> = {}
  for (const [project, entry] of Object.entries(record.projects as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as { agents?: unknown; entries?: unknown }
    const agents = Array.isArray(candidate.agents)
      ? candidate.agents.filter((agent): agent is string => typeof agent === 'string' && findAgentTarget(agent) !== undefined)
      : []
    const entries = Array.isArray(candidate.entries)
      ? candidate.entries.flatMap((item): LinkEntry[] => {
        if (typeof item !== 'object' || item === null) return []
        const entryCandidate = item as { source?: unknown; skillName?: unknown; enabled?: unknown }
        if (typeof entryCandidate.source !== 'string' || typeof entryCandidate.skillName !== 'string') return []
        return [{
          source: entryCandidate.source,
          skillName: entryCandidate.skillName,
          ...(entryCandidate.enabled === false ? { enabled: false } : {}),
        }]
      })
      : []
    if (agents.length === 0 || entries.length === 0) continue
    projects[project] = { agents, entries }
  }
  return { version: STATE_VERSION, projects }
}

function matchesRequest(entry: LinkEntry, request: LinkRequest): boolean {
  return entry.source === request.source
    && (request.skillName === undefined || entry.skillName === request.skillName)
}

function union(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])]
}

function mergeEntries(left: readonly LinkEntry[], right: readonly LinkEntry[]): LinkEntry[] {
  const key = (entry: LinkEntry): string => `${entry.source}/${entry.skillName}`
  const merged = new Map(left.map((entry) => [key(entry), entry]))
  // An explicit link request re-enables a previously disabled project entry.
  for (const entry of right) merged.set(key(entry), { ...entry, enabled: true })
  return [...merged.values()]
}

function withoutProject(file: LinkFile, project: string): LinkFile {
  const projects = { ...file.projects }
  delete projects[project]
  return { ...file, projects }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

