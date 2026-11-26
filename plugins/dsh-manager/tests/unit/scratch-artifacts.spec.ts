/** Unit tests for ancestor-aware scratch tasks & prototype directory resolution. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  extractScratchPrototypeDirFromText,
  extractScratchTaskDirFromText,
  resolveTaskScratchDir,
} from '../../src/dispatch/scratch-artifacts.ts'

describe('scratch-artifacts', () => {
  test('resolves ancestor scratch/tasks and scratch/prototypes paths from nested subrepo worktrees', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-scratch-root-'))
    try {
      const worktreeCwd = join(home, 'repos', 'dsh', '.dsh-worktrees', 't-1')
      await mkdir(worktreeCwd, { recursive: true })
      await mkdir(join(home, 'scratch', 'tasks'), { recursive: true })
      await mkdir(join(home, 'scratch', 'prototypes'), { recursive: true })

      expect(extractScratchTaskDirFromText(
        '对齐卡: home-repos/scratch/tasks/2026-11-26-demo/align-card.md',
        worktreeCwd,
      )).toBe(join(home, 'scratch', 'tasks', '2026-11-26-demo'))

      expect(extractScratchPrototypeDirFromText(
        '原型: scratch/prototypes/ticket-workbench/index.html',
        worktreeCwd,
      )).toBe(join(home, 'scratch', 'prototypes', 'ticket-workbench'))

      expect(resolveTaskScratchDir({
        scope: '参考 scratch/tasks/2026-11-26-demo/prototype/index.html',
        rootTicketId: 'ticket-root',
        basePath: worktreeCwd,
      })).toBe(join(home, 'scratch', 'tasks', '2026-11-26-demo'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
