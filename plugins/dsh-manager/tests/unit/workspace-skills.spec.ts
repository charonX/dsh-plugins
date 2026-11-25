/** Unit tests for workspace skill discovery and prompt formatting. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { discoverWorkspaceSkills, formatSkillPromptLines } from '../../src/dispatch/workspace-skills.ts'

describe('workspace-skills', () => {
  test('discovers skills from .agents/skills and .claude/skills without duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skills-'))
    try {
      await mkdir(join(root, '.agents', 'skills', 'tdd'), { recursive: true })
      await writeFile(join(root, '.agents', 'skills', 'tdd', 'SKILL.md'), [
        '---',
        'name: tdd',
        'description: Test-driven red-green-refactor workflow.',
        '---',
        '# TDD',
      ].join('\n'))
      await mkdir(join(root, '.claude', 'skills', 'tdd'), { recursive: true })
      await writeFile(join(root, '.claude', 'skills', 'tdd', 'SKILL.md'), [
        '---',
        'name: tdd',
        'description: Duplicate entry should be ignored.',
        '---',
      ].join('\n'))
      await mkdir(join(root, '.claude', 'skills', 'grill-me'), { recursive: true })
      await writeFile(join(root, '.claude', 'skills', 'grill-me', 'SKILL.md'), '# Grill\nStress-test a plan before coding.\n')

      const skills = await discoverWorkspaceSkills(root)
      expect(skills).toEqual([
        {
          name: 'tdd',
          description: 'Test-driven red-green-refactor workflow.',
          path: '.agents/skills/tdd/SKILL.md',
        },
        {
          name: 'grill-me',
          description: 'Stress-test a plan before coding.',
          path: '.claude/skills/grill-me/SKILL.md',
        },
      ])
      const lines = formatSkillPromptLines(skills)
      expect(lines[0]).toContain('Workspace skills available')
      expect(lines[1]).toBe('- tdd (.agents/skills/tdd/SKILL.md): Test-driven red-green-refactor workflow.')
      expect(lines[2]).toBe('- grill-me (.claude/skills/grill-me/SKILL.md): Stress-test a plan before coding.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('returns empty list when no skill directories exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-no-skills-'))
    try {
      expect(await discoverWorkspaceSkills(root)).toEqual([])
      expect(formatSkillPromptLines([])).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('discovers skills from an ancestor skills/ directory (e.g. home-repos/skills)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ancestor-skills-'))
    try {
      const subrepoWorktree = join(root, 'repos', 'dsh', '.dsh-worktrees', 'ticket-1')
      await mkdir(subrepoWorktree, { recursive: true })
      await mkdir(join(root, 'skills', 'bug-fix'), { recursive: true })
      await writeFile(join(root, 'skills', 'bug-fix', 'SKILL.md'), [
        '---',
        'name: bug-fix',
        'description: Repro first behavioral bug-fix loop.',
        '---',
      ].join('\n'))

      const skills = await discoverWorkspaceSkills(subrepoWorktree)
      expect(skills).toEqual([
        {
          name: 'bug-fix',
          description: 'Repro first behavioral bug-fix loop.',
          path: join(root, 'skills', 'bug-fix', 'SKILL.md'),
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
