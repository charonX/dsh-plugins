/**
 * Adaptive landing rule discovery: inspects target repository instructions
 * (`AGENTS.md`, `CLAUDE.md`, `docs/verify/README.md`), project-local PR/release
 * skills, and live git remotes/branches — requiring zero static `projects:`
 * configuration while defaulting safely when rules are absent or ambiguous.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { discoverWorkspaceSkills, type DiscoveredSkill } from './workspace-skills.ts'
import { runGit } from './worktree.ts'

const MAX_DOC_EXCERPT_CHARS = 2400
const CANDIDATE_DOC_NAMES = ['AGENTS.md', 'CLAUDE.md', 'docs/verify/README.md'] as const
const DEFAULT_BASE_BRANCH_CANDIDATES = ['main', 'master', 'test', 'develop'] as const
const PR_SKILL_PATTERN = /\b(pr|mr|pull|merge|ship|land|release|gitflow)\b/i
const DOC_LANDING_HINT_PATTERN = /\b(pr|mr|pull\s+request|merge\s+request|gitflow|merge\s+to\s+main|glab|gh\s+pr|ship-pr|cherry-pick)\b/i

/** One documentation file discovered in the repo or enclosing workspace root. */
export interface DiscoveredDoc {
  readonly path: string
  readonly scope: 'repo' | 'ancestor'
  readonly excerpt: string
  readonly mentionsLandingWorkflow: boolean
}

/** Git forge / remote classification inferred from `origin`. */
export type RemoteForgeKind = 'github' | 'gitlab' | 'unknown' | 'none'

/** Default fallback action when repo rules do not unambiguously pick automation. */
export type LandingFallbackMode = 'manual' | 'local-merge' | 'remote-pr' | 'remote-mr'

/** Complete project landing facts discovered dynamically for a dispatch repo. */
export interface ProjectLandingFacts {
  readonly repoRoot: string
  readonly currentBranch?: string
  readonly upstreamBranch?: string
  readonly originUrl?: string
  readonly forge: RemoteForgeKind
  readonly existingBaseBranches: readonly string[]
  readonly defaultBaseBranch?: string
  readonly docs: readonly DiscoveredDoc[]
  readonly deliverySkills: readonly DiscoveredSkill[]
  readonly hasExplicitLandingPolicy: boolean
  readonly recommendedFallback: LandingFallbackMode
}

function classifyForge(originUrl: string | undefined): RemoteForgeKind {
  if (originUrl === undefined || originUrl.trim() === '') return 'none'
  const lower = originUrl.toLowerCase()
  if (lower.includes('github.com') || lower.includes('github.')) return 'github'
  if (lower.includes('gitlab')) return 'gitlab'
  return 'unknown'
}

function ancestorDirs(startDir: string, maxDepth = 4): string[] {
  const dirs: string[] = []
  let current = resolve(startDir)
  for (let i = 0; i <= maxDepth; i++) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

async function readDocExcerpts(repoRoot: string): Promise<DiscoveredDoc[]> {
  const docs: DiscoveredDoc[] = []
  const seen = new Set<string>()
  const dirs = ancestorDirs(repoRoot, 4)

  for (let idx = 0; idx < dirs.length; idx++) {
    const dir = dirs[idx]!
    const scope: 'repo' | 'ancestor' = idx === 0 ? 'repo' : 'ancestor'
    // Only descend past repoRoot when an ancestor directory explicitly holds AGENTS.md (e.g. home-repos).
    if (scope === 'ancestor' && !existsSync(join(dir, 'AGENTS.md')) && !existsSync(join(dir, 'CLAUDE.md'))) {
      continue
    }
    for (const rel of CANDIDATE_DOC_NAMES) {
      if (scope === 'ancestor' && rel === 'docs/verify/README.md') continue
      const fullPath = join(dir, rel)
      if (seen.has(fullPath) || !existsSync(fullPath)) continue
      seen.add(fullPath)
      try {
        const raw = await readFile(fullPath, 'utf8')
        const trimmed = raw.trim()
        if (trimmed === '') continue
        const excerpt = trimmed.length > MAX_DOC_EXCERPT_CHARS
          ? `${trimmed.slice(0, MAX_DOC_EXCERPT_CHARS)}\n…(truncated)`
          : trimmed
        docs.push({
          path: fullPath,
          scope,
          excerpt,
          mentionsLandingWorkflow: DOC_LANDING_HINT_PATTERN.test(trimmed),
        })
      } catch {
        // Ignore unreadable docs; discovery must never block dispatch.
      }
    }
  }
  return docs
}

function chooseDefaultBaseBranch(
  originHead: string | undefined,
  existingBranches: readonly string[],
): string | undefined {
  if (originHead !== undefined && originHead !== '') {
    const stripped = originHead.replace(/^origin\//, '')
    if (stripped !== '' && existingBranches.includes(stripped)) return stripped
    return stripped
  }
  return existingBranches[0]
}

/**
 * Dynamically probe repository docs, skills, branches, and remote metadata
 * to give Delivery / PR stages grounded landing facts without a static config.
 */
export async function discoverProjectLandingFacts(
  subprocess: SubprocessRuntime,
  cwd: string,
): Promise<ProjectLandingFacts> {
  const topLevel = await runGit(subprocess, 'git', ['rev-parse', '--show-toplevel'], cwd)
  const repoRoot = topLevel.exitCode === 0 && topLevel.stdout.trim() !== ''
    ? topLevel.stdout.trim()
    : resolve(cwd)

  const [docs, skills] = await Promise.all([
    readDocExcerpts(repoRoot),
    discoverWorkspaceSkills(repoRoot),
  ])

  const deliverySkills = skills.filter(skill =>
    PR_SKILL_PATTERN.test(skill.name) || PR_SKILL_PATTERN.test(skill.description))

  let currentBranch: string | undefined
  let upstreamBranch: string | undefined
  let originUrl: string | undefined
  let originHead: string | undefined
  const existingBaseBranches: string[] = []

  if (topLevel.exitCode === 0) {
    const [branchRes, upstreamRes, remoteRes, originHeadRes, ...branchChecks] = await Promise.all([
      runGit(subprocess, 'git', ['symbolic-ref', '--short', 'HEAD'], repoRoot),
      runGit(subprocess, 'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot),
      runGit(subprocess, 'git', ['remote', 'get-url', 'origin'], repoRoot),
      runGit(subprocess, 'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot),
      ...DEFAULT_BASE_BRANCH_CANDIDATES.map(name =>
        runGit(subprocess, 'git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repoRoot)
          .then(res => ({ name, ok: res.exitCode === 0 }))),
    ])
    if (branchRes.exitCode === 0 && branchRes.stdout.trim() !== '') currentBranch = branchRes.stdout.trim()
    if (upstreamRes.exitCode === 0 && upstreamRes.stdout.trim() !== '') upstreamBranch = upstreamRes.stdout.trim()
    if (remoteRes.exitCode === 0 && remoteRes.stdout.trim() !== '') originUrl = remoteRes.stdout.trim()
    if (originHeadRes.exitCode === 0 && originHeadRes.stdout.trim() !== '') originHead = originHeadRes.stdout.trim()
    for (const check of branchChecks) {
      if (check.ok) existingBaseBranches.push(check.name)
    }
  }

  const forge = classifyForge(originUrl)
  const repoDocExplicit = docs.some(doc => doc.scope === 'repo' && doc.mentionsLandingWorkflow)
  const hasExplicitLandingPolicy = repoDocExplicit || deliverySkills.length > 0
  const defaultBaseBranch = chooseDefaultBaseBranch(originHead, existingBaseBranches)

  // Conservative safe fallback: when neither repo docs nor project-local skills
  // declare a landing rule, stay on the branch/worktree (`manual`) instead of
  // autonomously pushing or mutating `main`.
  let recommendedFallback: LandingFallbackMode = 'manual'
  if (hasExplicitLandingPolicy) {
    if (forge === 'gitlab') recommendedFallback = 'remote-mr'
    else if (forge === 'github') recommendedFallback = 'remote-pr'
    else if (forge === 'none' && defaultBaseBranch !== undefined) recommendedFallback = 'local-merge'
  }

  return {
    repoRoot,
    ...(currentBranch === undefined ? {} : { currentBranch }),
    ...(upstreamBranch === undefined ? {} : { upstreamBranch }),
    ...(originUrl === undefined ? {} : { originUrl }),
    forge,
    existingBaseBranches,
    ...(defaultBaseBranch === undefined ? {} : { defaultBaseBranch }),
    docs,
    deliverySkills,
    hasExplicitLandingPolicy,
    recommendedFallback,
  }
}

/** Format discovered project landing facts into prompt instructions for Delivery/Review agents. */
export function formatLandingDiscoveryPromptLines(facts: ProjectLandingFacts): string[] {
  const lines: string[] = [
    'Project landing discovery (dynamically probed — follow repo rules & project skills first; if ambiguous, keep changes verified on current branch and ask human):',
    `- repoRoot: ${facts.repoRoot}`,
    `- currentBranch: ${facts.currentBranch ?? '(unknown/non-git)'}${facts.upstreamBranch === undefined ? '' : ` | upstream: ${facts.upstreamBranch}`}`,
    `- originRemote: ${facts.originUrl ?? '(none)'} (forge: ${facts.forge})`,
    `- baseBranchCandidates: ${facts.existingBaseBranches.length > 0 ? facts.existingBaseBranches.join(', ') : '(none)'}${facts.defaultBaseBranch === undefined ? '' : ` (default: ${facts.defaultBaseBranch})`}`,
    `- safeFallbackMode: ${facts.recommendedFallback} (explicitPolicy=${String(facts.hasExplicitLandingPolicy)})`,
  ]
  if (facts.deliverySkills.length > 0) {
    lines.push('Discovered project/workspace delivery & PR skills (prefer project-local skill over generic defaults):')
    for (const skill of facts.deliverySkills) {
      lines.push(`  - /${skill.name} (${skill.path}): ${skill.description}`)
    }
  }
  for (const doc of facts.docs) {
    lines.push(`--- ${doc.scope.toUpperCase()} DOC: ${doc.path} ---`)
    lines.push(doc.excerpt)
  }
  return lines
}
