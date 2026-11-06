/**
 * HTTP surface of the skills manager: one `prefix` route registered on the
 * host web server, answering the Web Client's JSON requests.
 *
 * Mutating requests are checked against the host trust rules (loopback or a
 * declared `trustedHosts` authority, no cross-site fetch, matching `Origin`)
 * because they install code-bearing directories into the user's library.
 *
 * @module dsh-skills-manager/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SkillManagerError } from './errors.js'
import {
  ensureGitAvailable,
  assertGitIdentifier,
  installGitSource,
  installLocalSource,
  removeSourceDirectory,
  updateGitSource,
  type InstallerOptions,
} from './installer.js'
import type { JobRegistry } from './jobs.js'
import type { LinkManager } from './links.js'
import { listAgentTargets } from './links.js'
import { importSkills, type ImportStore } from './imports.js'
import { scanGlobalSkills } from './scan.js'
import { checkGitSource, type UpdateStore } from './updates.js'
import { scanLibrary, type WarnLogger } from './library.js'
import { assertDirectoryName, isInsideOrEqual } from './paths.js'
import type {
  AgentTargetView,
  ApiErrorBody,
  InstallRequestBody,
  JobAcceptedBody,
  JobView,
  LibrarySnapshot,
  LinkRequestBody,
  LinkReport,
  ProjectLinkView,
  SkillPatch,
  SourcePatch,
  WorkspaceOptionView,
} from './shared/api.js'
import { buildSnapshot } from './view.js'
import type { StateStore } from './state.js'

/** Host services the routes read, injected through live getters. */
export interface HttpDeps {
  /** Absolute route prefix, without a trailing slash. */
  readonly prefix: string
  /** Absolute library root. */
  readonly libraryDir: string
  /** Absolute state file path. */
  readonly statePath: string
  /** Whether `file://` git identifiers are accepted. */
  readonly allowFileProtocol: boolean
  /** Manager state store. */
  readonly state: StateStore
  /** Job registry. */
  readonly jobs: JobRegistry
  /** Project symlink distribution manager. */
  readonly links: LinkManager
  /** Persisted update-check results. */
  readonly updates: UpdateStore
  /** Import provenance. */
  readonly imports: ImportStore
  /** Extra global skill roots offered by the import scanner. */
  readonly scanExtraRoots: readonly string[]
  /** DSH workspaces offered as link targets. */
  readonly listWorkspaces: () => readonly WorkspaceOptionView[]
  /** Plugin logger. */
  readonly logger: WarnLogger
  /**
   * Read the host connection service for declared trusted authorities.
   * @returns the current trusted host list, or undefined without the service.
   */
  readonly trustedHosts: () => readonly string[] | undefined
  /** Invalidate the skill catalog after a successful mutation. */
  readonly onLibraryChanged: () => void
}

/** Largest accepted JSON body: install identifiers plus notes. */
const MAX_BODY_BYTES = 64 * 1024

/** Notes and categories are display copy, not documents. */
const MAX_TEXT_LENGTH = 2000

/**
 * Create the request handler registered on `ctx.webServer`.
 * @param deps - resolved host dependencies.
 * @returns the route handler.
 */
export function createRequestHandler(
  deps: HttpDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const segments = matchSegments(url.pathname, deps.prefix)
      if (segments === undefined) {
        sendError(response, new SkillManagerError(404, 'NOT_FOUND', 'Unknown skills-manager route'))
        return
      }
      const method = request.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD' && !isTrustedRequest(request, deps.trustedHosts())) {
        sendError(response, new SkillManagerError(403, 'UNTRUSTED_REQUEST', 'This request did not come from the DSH page'))
        return
      }
      await dispatch(deps, request, response, method, segments)
    } catch (error) {
      if (error instanceof SkillManagerError) {
        sendError(response, error)
        return
      }
      deps.logger.warn(`skills-manager: unhandled route failure: ${errorMessage(error)}`)
      sendError(response, new SkillManagerError(500, 'INTERNAL_ERROR', errorMessage(error)))
    }
  }
}

async function dispatch(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  segments: readonly string[],
): Promise<void> {
  const [first, second, third, fourth] = segments
  if (first !== 'api') {
    throw new SkillManagerError(404, 'NOT_FOUND', 'Unknown skills-manager route')
  }

  if (second === 'library' && segments.length === 2) {
    requireMethod(method, ['GET', 'HEAD'])
    sendJson(response, 200, snapshotOf(deps))
    return
  }

  if (second === 'sources' && third === 'install' && segments.length === 3) {
    requireMethod(method, ['POST'])
    const body = await readInstallBody(request)
    const accepted = await startInstall(deps, body)
    sendJson(response, 202, accepted)
    return
  }

  if (second === 'agents' && segments.length === 2) {
    requireMethod(method, ['GET', 'HEAD'])
    sendJson(response, 200, { agents: listAgentTargets() satisfies readonly AgentTargetView[] })
    return
  }

  if (second === 'scan' && segments.length === 2) {
    requireMethod(method, ['GET', 'HEAD'])
    sendJson(response, 200, scanGlobalSkills({
      extraRoots: deps.scanExtraRoots,
      libraryDir: deps.libraryDir,
      importedKeys: deps.imports.keys(),
      logger: deps.logger,
    }))
    return
  }

  if (second === 'import' && segments.length === 2) {
    requireMethod(method, ['POST'])
    const body = await readJsonBody(request)
    const paths = body.paths
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
      throw new SkillManagerError(400, 'IMPORT_EMPTY', 'paths must be an array of absolute skill paths')
    }
    if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
      throw new SkillManagerError(400, 'INVALID_JSON', 'overwrite must be a boolean')
    }
    const result = importSkills(
      {
        libraryDir: deps.libraryDir,
        store: deps.imports,
        extraRoots: deps.scanExtraRoots,
        logger: deps.logger,
      },
      { paths: paths as readonly string[], ...(body.overwrite === true ? { overwrite: true } : {}) },
    )
    deps.onLibraryChanged()
    sendJson(response, 200, result)
    return
  }

  if (second === 'projects' && segments.length === 2) {
    requireMethod(method, ['GET', 'HEAD'])
    sendJson(response, 200, { projects: deps.listWorkspaces() })
    return
  }

  if (second === 'links' && third === 'resync' && segments.length === 3) {
    requireMethod(method, ['POST'])
    const body = await readJsonBody(request)
    sendJson(response, 200, deps.links.resync(requireProject(body)) satisfies LinkReport)
    return
  }

  if (second === 'links' && segments.length === 2) {
    if (method === 'GET' || method === 'HEAD') {
      sendJson(response, 200, { projects: deps.links.listProjects() satisfies readonly ProjectLinkView[] })
      return
    }
    requireMethod(method, ['POST', 'DELETE', 'PUT'])
    const body = await readLinkBody(request)
    if (method === 'PUT') {
      if (body.enabled === undefined) {
        throw new SkillManagerError(400, 'INVALID_JSON', '"enabled" is required to change a project distribution')
      }
      sendJson(response, 200, deps.links.setEnabled({ ...body, enabled: body.enabled }))
      return
    }
    const report = method === 'POST' ? deps.links.link(body) : deps.links.unlink(body)
    sendJson(response, 200, report)
    return
  }

  if (second === 'sources' && third !== undefined && segments[3] === 'check' && segments.length === 4) {
    requireMethod(method, ['POST'])
    const slug = assertDirectoryName(third, 'source')
    const sourceDir = sourceDirectory(deps, slug)
    const check = await checkGitSource(sourceDir, { allowFileProtocol: deps.allowFileProtocol })
    deps.updates.set(slug, check)
    sendJson(response, 200, { check })
    return
  }

  if (second === 'jobs' && third !== undefined && segments.length === 3) {
    requireMethod(method, ['GET', 'HEAD'])
    const job = deps.jobs.view(third)
    if (job === undefined) throw new SkillManagerError(404, 'NOT_FOUND', `Unknown job: ${third}`)
    sendJson(response, 200, job satisfies JobView)
    return
  }

  if (second === 'sources' && third !== undefined) {
    const slug = assertDirectoryName(third, 'source')
    if (fourth === 'update' && segments.length === 4) {
      requireMethod(method, ['POST'])
      sendJson(response, 202, await startUpdate(deps, slug))
      return
    }
    if (fourth === 'skills' && segments[4] !== undefined && segments.length === 5) {
      requireMethod(method, ['PUT'])
      const skillName = assertDirectoryName(segments[4], 'skill')
      const patch = readSkillPatch(await readJsonBody(request))
      deps.state.patchSkill(slug, skillName, patch)
      if (patch.enabled === false) deps.links.detach(slug, skillName)
      else if (patch.enabled === true) deps.links.restore(slug, skillName)
      sendJson(response, 200, snapshotOf(deps))
      deps.onLibraryChanged()
      return
    }
    if (segments.length === 3) {
      if (method === 'PUT') {
        sourceDirectory(deps, slug)
        const patch = readSourcePatch(await readJsonBody(request))
        deps.state.patchSource(slug, patch)
        if (patch.enabled === false) deps.links.detach(slug)
        else if (patch.enabled === true) deps.links.restore(slug)
        sendJson(response, 200, snapshotOf(deps))
        deps.onLibraryChanged()
        return
      }
      if (method === 'DELETE') {
        removeSource(deps, slug)
        sendJson(response, 200, snapshotOf(deps))
        deps.onLibraryChanged()
        return
      }
      requireMethod(method, ['PUT', 'DELETE'])
    }
  }

  throw new SkillManagerError(404, 'NOT_FOUND', 'Unknown skills-manager route')
}

function snapshotOf(deps: HttpDeps): LibrarySnapshot {
  return buildSnapshot(
    deps.libraryDir,
    deps.statePath,
    scanLibrary(deps.libraryDir, deps.logger),
    deps.state.read(),
    deps.updates.read(),
  )
}

async function startInstall(deps: HttpDeps, body: InstallRequestBody): Promise<JobAcceptedBody> {
  const options: InstallerOptions = {
    libraryDir: deps.libraryDir,
    allowFileProtocol: deps.allowFileProtocol,
  }
  const job = deps.jobs.create()
  if (body.sourceType === 'git') {
    const identifier = assertGitIdentifier(body.identifier, deps.allowFileProtocol)
    // Reject a missing git before the job is visible to pollers.
    await ensureGitAvailable()
    return deps.jobs.start(job, async () => {
      await installGitSource(job, options, identifier)
      deps.onLibraryChanged()
    })
  }
  const identifier = body.identifier
  const force = body.force === true
  return deps.jobs.start(job, async () => {
    await installLocalSource(job, options, identifier, force)
    deps.onLibraryChanged()
  })
}

async function startUpdate(deps: HttpDeps, slug: string): Promise<JobAcceptedBody> {
  const sourceDir = sourceDirectory(deps, slug)
  const options: InstallerOptions = {
    libraryDir: deps.libraryDir,
    allowFileProtocol: deps.allowFileProtocol,
  }
  const job = deps.jobs.create()
  return deps.jobs.start(job, async () => {
    await updateGitSource(job, options, sourceDir)
    deps.onLibraryChanged()
  })
}

function removeSource(deps: HttpDeps, slug: string): void {
  const sourceDir = sourceDirectory(deps, slug)
  deps.links.forgetSource(slug)
  deps.updates.drop(slug)
  deps.imports.dropSource(slug)
  removeSourceDirectory(sourceDir)
  deps.state.dropSource(slug)
}

function sourceDirectory(deps: HttpDeps, slug: string): string {
  const dir = join(deps.libraryDir, slug)
  if (!existsSync(dir) || !isInsideOrEqual(deps.libraryDir, dir)) {
    throw new SkillManagerError(404, 'NOT_FOUND', `Unknown skill source: ${slug}`)
  }
  return dir
}

function requireMethod(method: string, allowed: readonly string[]): void {
  if (!allowed.includes(method)) {
    throw new SkillManagerError(405, 'METHOD_NOT_ALLOWED', `Method ${method} is not allowed here; use ${allowed.join(' or ')}`)
  }
}

function matchSegments(pathname: string, prefix: string): string[] | undefined {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return undefined
  const rest = pathname.slice(prefix.length)
  const segments = rest.split('/').filter((segment) => segment !== '')
  return segments.map(safeDecode)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new SkillManagerError(400, 'INVALID_PATH', 'Malformed path segment')
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new SkillManagerError(413, 'BODY_TOO_LARGE', `Request body exceeds ${String(MAX_BODY_BYTES)} bytes`)
    }
    chunks.push(buffer)
  }
  if (size === 0) throw new SkillManagerError(400, 'INVALID_JSON', 'A JSON body is required')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SkillManagerError(400, 'INVALID_JSON', 'Request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SkillManagerError(400, 'INVALID_JSON', 'Request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

async function readInstallBody(request: IncomingMessage): Promise<InstallRequestBody> {
  const body = await readJsonBody(request)
  const sourceType = body.sourceType
  if (sourceType !== 'git' && sourceType !== 'local') {
    throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', 'sourceType must be "git" or "local"')
  }
  const identifier = body.identifier
  if (typeof identifier !== 'string' || identifier.trim() === '') {
    throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', 'identifier is required')
  }
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    throw new SkillManagerError(400, 'SKILL_SOURCE_INVALID', 'force must be a boolean')
  }
  return {
    sourceType,
    identifier: identifier.trim(),
    ...(body.force === true ? { force: true } : {}),
  }
}

async function readLinkBody(request: IncomingMessage): Promise<LinkRequestBody> {
  const body = await readJsonBody(request)
  const project = requireProject(body)
  const source = body.source
  if (typeof source !== 'string') {
    throw new SkillManagerError(400, 'SKILL_IDENTITY_INVALID', 'source is required')
  }
  const skillName = body.skillName
  if (skillName !== undefined && typeof skillName !== 'string') {
    throw new SkillManagerError(400, 'SKILL_IDENTITY_INVALID', 'skillName must be a string')
  }
  const agents = body.agents
  if (agents !== undefined && (!Array.isArray(agents) || agents.some((agent) => typeof agent !== 'string'))) {
    throw new SkillManagerError(400, 'AGENT_INVALID', 'agents must be an array of registry keys')
  }
  const enabled = body.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new SkillManagerError(400, 'INVALID_JSON', 'enabled must be a boolean')
  }
  return {
    project,
    source: assertDirectoryName(source, 'source'),
    ...(skillName === undefined ? {} : { skillName: assertDirectoryName(skillName, 'skill') }),
    ...(agents === undefined ? {} : { agents: agents as readonly string[] }),
    ...(enabled === undefined ? {} : { enabled }),
  }
}

function requireProject(body: Record<string, unknown>): string {
  const project = body.project
  if (typeof project !== 'string' || project.trim() === '') {
    throw new SkillManagerError(400, 'PROJECT_INVALID', 'project is required')
  }
  return project.trim()
}

function readSourcePatch(body: Record<string, unknown>): SourcePatch {
  const enabled = readBoolean(body, 'enabled')
  const category = readText(body, 'category')
  const note = readText(body, 'note')
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(category === undefined ? {} : { category }),
    ...(note === undefined ? {} : { note }),
  }
}

function readSkillPatch(body: Record<string, unknown>): SkillPatch {
  const enabled = readBoolean(body, 'enabled')
  const note = readText(body, 'note')
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(note === undefined ? {} : { note }),
  }
}

function readBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new SkillManagerError(400, 'INVALID_JSON', `"${key}" must be a boolean`)
  return value
}

function readText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new SkillManagerError(400, 'INVALID_JSON', `"${key}" must be a string`)
  if (value.length > MAX_TEXT_LENGTH) {
    throw new SkillManagerError(400, 'INVALID_JSON', `"${key}" exceeds ${String(MAX_TEXT_LENGTH)} characters`)
  }
  return value
}

/**
 * Apply the host's browser-trust rules to a mutating request.
 * @param request - incoming request.
 * @param trustedHosts - authorities the deployment declared, if any.
 * @returns whether the request may mutate manager state.
 */
export function isTrustedRequest(request: IncomingMessage, trustedHosts: readonly string[] | undefined): boolean {
  const host = request.headers.host
  if (host !== undefined && !isLoopbackAuthority(host) && !isTrustedAuthority(host, trustedHosts ?? [])) {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  // A missing Origin did not come from a page (the Desktop proxy strips it);
  // a present one must name the same authority.
  if (origin === undefined) return true
  try {
    const originUrl = new URL(origin)
    if (originUrl.host === host) return true
    // Chrome 151+ omits the port on loopback Origins.
    if (originUrl.port === '' && host !== undefined && isLoopbackAuthority(host)) {
      const hostUrl = parseAuthority(host)
      return hostUrl !== null && originUrl.hostname === hostUrl.hostname
    }
    return false
  } catch {
    return false
  }
}

function isLoopbackAuthority(host: string): boolean {
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

function isTrustedAuthority(host: string, trustedHosts: readonly string[]): boolean {
  const hostUrl = parseAuthority(host)
  if (hostUrl === null) return false
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === null) return false
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

function parseAuthority(value: string): URL | null {
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === value.toLowerCase() ? url : null
  } catch {
    return null
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function sendError(response: ServerResponse, error: SkillManagerError): void {
  const body: ApiErrorBody = { error: { code: error.code, message: error.message } }
  sendJson(response, error.status, body)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
