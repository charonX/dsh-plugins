/** Unit tests for unified workspace + host `ctx.skills` discovery and prompt formatting. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { discoverWorkspaceSkills, formatSkillPromptLines, loadSkillMarkdown } from '../../src/dispatch/workspace-skills.ts'

describe('workspace-skills', () => {
  test('discovers skills from .dsh/skills, .agents/skills, .claude/skills, and host ctx.skills without duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skills-'))
    try {
      await mkdir(join(root, '.dsh', 'skills', 'how'), { recursive: true })
      await writeFile(join(root, '.dsh', 'skills', 'how', 'SKILL.md'), [
        '---',
        'name: how',
        'description: Read-only codebase exploration.',
        '---',
      ].join('\n'))
      await mkdir(join(root, '.agents', 'skills', 'tdd'), { recursive: true })
      await writeFile(join(root, '.agents', 'skills', 'tdd', 'SKILL.md'), [
        '---',
        'name: tdd',
        'description: Test-driven red-green-refactor workflow.',
        '---',
      ].join('\n'))
      await mkdir(join(root, '.claude', 'skills', 'tdd'), { recursive: true })
      await writeFile(join(root, '.claude', 'skills', 'tdd', 'SKILL.md'), [
        '---',
        'name: tdd',
        'description: Duplicate entry should be ignored.',
        '---',
      ].join('\n'))

      const skills = await discoverWorkspaceSkills(root, {
        async list() {
          return [
            { name: 'tdd', description: 'Host duplicate should be ignored.' },
            { name: 'writing-style', description: 'Knowledge base writing rules.' },
          ]
        },
        async get(name) {
          return name === 'writing-style'
            ? { name, content: '# Writing Style\n1. Outline\n2. Draft\n' }
            : undefined
        },
      })

      expect(skills).toEqual([
        {
          name: 'how',
          description: 'Read-only codebase exploration.',
          path: '.dsh/skills/how/SKILL.md',
          source: 'workspace',
        },
        {
          name: 'tdd',
          description: 'Test-driven red-green-refactor workflow.',
          path: '.agents/skills/tdd/SKILL.md',
          source: 'workspace',
        },
        {
          name: 'writing-style',
          description: 'Knowledge base writing rules.',
          path: 'ctx.skills:writing-style',
          source: 'host',
        },
      ])

      const lines = formatSkillPromptLines(skills, ['tdd'])
      expect(lines[0]).toContain('Required step skills')
      expect(lines[1]).toContain('- tdd (.agents/skills/tdd/SKILL.md)')
      expect(lines[2]).toContain('Other available skills')
      expect(lines.some(l => l.includes('writing-style'))).toBe(true)

      const loaded = await loadSkillMarkdown('skill', 'writing-style', root, {
        async list() { return [{ name: 'writing-style', description: 'Knowledge base writing rules.' }] },
        async get(name) { return name === 'writing-style' ? { name, content: '# Writing Style\n' } : undefined },
      })
      expect(loaded.content).toContain('# Writing Style')
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
          source: 'workspace',
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
