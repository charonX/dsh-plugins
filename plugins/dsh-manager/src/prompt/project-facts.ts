/**
 * Host-only project documentation probe for dynamic prompt context
 * (`AGENTS.md`/`CLAUDE.md`, `docs/git-flow.md`, `docs/verify/README.md`).
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ProjectLandingFacts } from '../dispatch/landing-discovery.ts'

/** Probed documentation and repository facts for one target workspace. */
export interface ProjectFactsSnapshot {
  readonly root: string
  readonly agentsMd?: string
  readonly gitFlow?: string
  readonly verifyDocs?: string
  readonly landingFacts?: ProjectLandingFacts
}

const MAX_VAR_DOC_CHARS = 2000

async function readDocSnippet(filePath: string): Promise<string | undefined> {
  if (!existsSync(filePath)) return undefined
  try {
    const raw = (await readFile(filePath, 'utf8')).trim()
    if (raw === '') return undefined
    return raw.length > MAX_VAR_DOC_CHARS ? `${raw.slice(0, MAX_VAR_DOC_CHARS)}\n…(truncated)` : raw
  } catch {
    return undefined
  }
}

/** Probe project docs (`AGENTS.md`/`CLAUDE.md`, `docs/git-flow.md`, `docs/verify/README.md`) without mutating state. */
export async function probeProjectFacts(
  rootPath: string,
  landingFacts?: ProjectLandingFacts,
): Promise<ProjectFactsSnapshot> {
  const root = resolve(landingFacts?.repoRoot ?? rootPath)
  const agentsDocFromLanding = landingFacts?.docs.find(d =>
    d.scope === 'repo' && (d.path.endsWith('/AGENTS.md') || d.path.endsWith('/CLAUDE.md')),
  )?.excerpt
    ?? landingFacts?.docs.find(d => d.path.endsWith('/AGENTS.md') || d.path.endsWith('/CLAUDE.md'))?.excerpt
  const verifyDocFromLanding = landingFacts?.docs.find(d => d.path.endsWith('/docs/verify/README.md'))?.excerpt

  const [agentsMd, gitFlow, verifyDocs] = await Promise.all([
    agentsDocFromLanding !== undefined
      ? Promise.resolve(agentsDocFromLanding)
      : (async () => (await readDocSnippet(join(root, 'AGENTS.md'))) ?? (await readDocSnippet(join(root, 'CLAUDE.md'))))(),
    readDocSnippet(join(root, 'docs', 'git-flow.md')),
    verifyDocFromLanding !== undefined
      ? Promise.resolve(verifyDocFromLanding)
      : readDocSnippet(join(root, 'docs', 'verify', 'README.md')),
  ])

  return {
    root,
    ...(agentsMd === undefined ? {} : { agentsMd }),
    ...(gitFlow === undefined ? {} : { gitFlow }),
    ...(verifyDocs === undefined ? {} : { verifyDocs }),
    ...(landingFacts === undefined ? {} : { landingFacts }),
  }
}
