/**
 * Browser client of the skills manager HTTP API.
 *
 * Paths resolve against `document.baseURI` so the page also works behind a
 * reverse proxy that mounts dsh under a prefix.
 *
 * @module dsh-skills-manager/client/api
 */

import type {
  AgentTargetView,
  ApiErrorBody,
  InstallRequestBody,
  JobView,
  LibrarySnapshot,
  LinkReport,
  LinkRequestBody,
  ProjectLinkView,
  WorkspaceOptionView,
  SkillPatch,
  SourcePatch,
  UpdateCheck,
} from '../shared/api.ts'
import { DEFAULT_ROUTE_PREFIX } from '../shared/api.ts'

/** Failure reported by the Host, carrying the machine-readable code. */
export class ApiFailure extends Error {
  /**
   * @param status - HTTP status.
   * @param code - machine-readable failure code.
   * @param message - human-readable message.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiFailure'
  }
}

/**
 * Resolve a route against the page the UI is served from.
 * @param path - route without the plugin prefix.
 * @returns the document-relative pathname.
 */
export function apiPath(path: string): string {
  const relative = `${DEFAULT_ROUTE_PREFIX.replace(/^\/+/u, '')}${path}`
  if (typeof document === 'undefined') return `/${relative}`
  return new URL(relative, document.baseURI).pathname
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(path), {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const text = await response.text()
  const body: unknown = text === '' ? undefined : safeJson(text)
  if (!response.ok) {
    const failure = body as ApiErrorBody | undefined
    throw new ApiFailure(
      response.status,
      failure?.error?.code ?? 'REQUEST_FAILED',
      failure?.error?.message ?? `Request failed with status ${String(response.status)}`,
    )
  }
  return body as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Read the library snapshot.
 * @returns the current sources, skills, and manager state.
 */
export async function loadLibrary(): Promise<LibrarySnapshot> {
  return await request<LibrarySnapshot>('/api/library')
}

/**
 * Start an install job.
 * @param body - source type, identifier, and optional overwrite flag.
 * @returns the job id to poll.
 */
export async function installSource(body: InstallRequestBody): Promise<string> {
  const accepted = await request<{ jobId: string }>('/api/sources/install', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return accepted.jobId
}

/**
 * Start an update job.
 * @param slug - source slug.
 * @returns the job id to poll.
 */
export async function updateSource(slug: string): Promise<string> {
  const accepted = await request<{ jobId: string }>(`/api/sources/${encodeURIComponent(slug)}/update`, { method: 'POST' })
  return accepted.jobId
}

/**
 * Remove one source.
 * @param slug - source slug.
 * @returns the refreshed snapshot.
 */
export async function removeSource(slug: string): Promise<LibrarySnapshot> {
  return await request<LibrarySnapshot>(`/api/sources/${encodeURIComponent(slug)}`, { method: 'DELETE' })
}

/**
 * Patch source state.
 * @param slug - source slug.
 * @param patch - fields to set.
 * @returns the refreshed snapshot.
 */
export async function patchSource(slug: string, patch: SourcePatch): Promise<LibrarySnapshot> {
  return await request<LibrarySnapshot>(`/api/sources/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

/**
 * Patch one skill's state.
 * @param slug - source slug.
 * @param skillName - skill directory name.
 * @param patch - fields to set.
 */
export async function patchSkill(slug: string, skillName: string, patch: SkillPatch): Promise<void> {
  await request<unknown>(`/api/sources/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skillName)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

/**
 * Poll one job until it settles.
 * @param jobId - job id.
 * @param onLog - receives the accumulated command output on every poll.
 * @throws {ApiFailure} carrying the job error code when the job fails.
 */
export async function waitForJob(jobId: string, onLog?: (log: string | null) => void): Promise<void> {
  for (;;) {
    const job = await request<JobView>(`/api/jobs/${encodeURIComponent(jobId)}`)
    onLog?.(job.log)
    if (job.status === 'success') return
    if (job.status === 'error') {
      throw new ApiFailure(500, job.error?.code ?? 'SKILL_JOB_FAILED', job.error?.message ?? 'Skill job failed')
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/**
 * Read the pinned agent-directory registry.
 * @returns one row per agent convention.
 */
export async function loadAgents(): Promise<readonly AgentTargetView[]> {
  const body = await request<{ agents: readonly AgentTargetView[] }>('/api/agents')
  return body.agents
}

/**
 * Read every recorded project with its refreshed link state.
 * @returns one view per project.
 */
export async function loadLinks(): Promise<readonly ProjectLinkView[]> {
  const body = await request<{ projects: readonly ProjectLinkView[] }>('/api/links')
  return body.projects
}

/**
 * Link a source (or one of its skills) into a project.
 * @param body - project, source, optional skill, and agent targets.
 * @returns the refreshed project report.
 */
export async function linkSource(body: LinkRequestBody): Promise<LinkReport> {
  return await request<LinkReport>('/api/links', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * Remove links of a source (or one of its skills) from a project.
 * @param body - project, source, optional skill, and agent targets.
 * @returns the refreshed project report.
 */
export async function unlinkSource(body: LinkRequestBody): Promise<LinkReport> {
  return await request<LinkReport>('/api/links', { method: 'DELETE', body: JSON.stringify(body) })
}

/**
 * Rebuild every recorded link of one project.
 * @param project - absolute project directory.
 * @returns the refreshed project report.
 */
export async function resyncProject(project: string): Promise<LinkReport> {
  return await request<LinkReport>('/api/links/resync', { method: 'POST', body: JSON.stringify({ project }) })
}

/**
 * Fetch and record an update check for one git source.
 * @param slug - source slug.
 * @returns the observation; a comparison failure is carried on `error`.
 */
export async function checkSource(slug: string): Promise<UpdateCheck> {
  const body = await request<{ check: UpdateCheck }>(`/api/sources/${encodeURIComponent(slug)}/check`, { method: 'POST' })
  return body.check
}

/**
 * Read the DSH workspaces offered as link targets.
 * @returns workspace paths with their titles.
 */
export async function loadWorkspaces(): Promise<readonly WorkspaceOptionView[]> {
  const body = await request<{ projects: readonly WorkspaceOptionView[] }>('/api/projects')
  return body.projects
}

/**
 * Turn this project's distribution of one skill (or a whole source) on or off.
 * @param body - project, source, optional skill, and the desired switch.
 * @returns the refreshed project report.
 */
export async function setLinkEnabled(body: LinkRequestBody & { readonly enabled: boolean }): Promise<LinkReport> {
  return await request<LinkReport>('/api/links', { method: 'PUT', body: JSON.stringify(body) })
}
