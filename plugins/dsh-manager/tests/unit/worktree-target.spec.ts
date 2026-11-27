/** Unit tests for deterministic ticket → target-repo detection (worktree root). */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { decideRepoRoot, detectTicketTargetRepo, namedRepoTargetOf } from '../../src/dispatch/worktree-target.ts'

async function seedRepo(root: string, relative: string): Promise<string> {
  const repoRoot = join(root, relative)
  await mkdir(join(repoRoot, '.git'), { recursive: true })
  await writeFile(join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  return repoRoot
}

describe('worktree-target', () => {
  test('reads the first repos/<name> mention in title, mandate, then acceptance criteria', () => {
    expect(namedRepoTargetOf({
      title: '[dsh-manager] tune prompt',
      mandateScope: '只改 repos/dsh/plugins/dsh-manager，别动 references/other',
    })).toBe('repos/dsh')
    expect(namedRepoTargetOf({ title: 'no repo mentioned here' })).toBeUndefined()
    expect(namedRepoTargetOf({
      title: 'fix loader',
      acceptanceCriteria: '1. run `repos/dsh/../external-agents` tests',
    })).toBe('repos/dsh')
  })

  test('resolves a named sub-repo above the mapped workspace root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-target-'))
    try {
      const dsh = await seedRepo(home, 'repos/dsh')
      const detection = detectTicketTargetRepo({ title: 'work in repos/dsh' }, [home])
      expect(detection).toEqual({ kind: 'named', relativePath: 'repos/dsh', repoRoot: dsh })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('reports a named sub-repo that does not exist instead of silently using the workspace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-target-missing-'))
    try {
      const detection = detectTicketTargetRepo({ title: 'work in repos/ghost' }, [home])
      expect(detection.kind).toBe('missing')
      expect(detection.kind === 'missing' ? detection.triedPaths[0] : '').toBe(join(home, 'repos', 'ghost'))
      const decision = decideRepoRoot({ detection, planRepoRoot: home, mappedRoot: home })
      expect(decision.targetRepoError).toContain('repos/ghost')
      expect(decision.repoRoot).toBe(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('the ticket-named repo overrides an aggregate-workspace plan root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-target-plan-'))
    try {
      const dsh = await seedRepo(home, 'repos/dsh')
      const detection = detectTicketTargetRepo({ title: 'work in repos/dsh' }, [home])
      const decision = decideRepoRoot({ detection, planRepoRoot: home, mappedRoot: home })
      expect(decision.repoRoot).toBe(dsh)
      expect(decision.corrected).toBe(true)
      expect(decision.targetRepoError).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('keeps the plan root when the ticket names no sub-repo', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-target-none-'))
    try {
      const planRoot = await seedRepo(home, 'repos/solo')
      const detection = detectTicketTargetRepo({ title: 'polish the case list UI' }, [home])
      expect(detection.kind).toBe('none')
      expect(decideRepoRoot({ detection, planRepoRoot: planRoot, mappedRoot: home }).repoRoot).toBe(planRoot)
      expect(decideRepoRoot({ detection, mappedRoot: home }).repoRoot).toBe(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
