/** Unit tests for Playbook-backed presets: built-in defaults, workspace overrides, and standalone compilation. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { materializeCompiledPlaybook, validateFlows } from '../../src/flow/flow-ir.ts'
import { discoverAndCompileDefaultPlaybooks, discoverPlaybooks } from '../../src/flow/playbook-catalog.ts'

describe('playbook-backed presets & catalog', () => {
  test('built-in default Playbooks cover code-dev, bug-fix, knowledge-creation, and refactoring without repo hardcoding', async () => {
    const standalone = await mkdtemp(join(tmpdir(), 'dsh-standalone-'))
    try {
      const catalog = await discoverPlaybooks(standalone)
      expect(catalog.map(p => p.id).sort()).toEqual(['bug-fix', 'code-dev', 'knowledge-creation', 'refactoring'])
      expect(catalog.every(p => p.source === 'builtin')).toBe(true)

      const compiled = await discoverAndCompileDefaultPlaybooks({ cwd: standalone, now: 100 })
      const flows = compiled.map(entry => entry.flow)
      expect(flows.map(f => f.id)).toEqual(['code-dev', 'bug-fix', 'knowledge-creation', 'refactoring'])
      expect(() => validateFlows(flows)).not.toThrow()

      const serialized = JSON.stringify(flows)
      expect(serialized).not.toContain('home-repos')
      expect(serialized).not.toContain('dsh-manager')

      const codeDev = flows.find(f => f.id === 'code-dev')!
      expect(codeDev.workspaceMode).toBe('worktree')
      expect(codeDev.steps.find(s => s.id === 'align')?.humanConfirm).toBe(true)
      expect(codeDev.steps.find(s => s.id === 'review')?.onFail).toBe('implement')

      const knowledge = flows.find(f => f.id === 'knowledge-creation')!
      expect(knowledge.workspaceMode).toBe('in-place')
      expect(knowledge.steps.some(s => s.onFail === 'draft')).toBe(true)
      expect(knowledge.steps.some(s => s.skills.includes('writing'))).toBe(true)
    } finally {
      await rm(standalone, { recursive: true, force: true })
    }
  })

  test('workspace skills/playbooks/*.md overrides built-in Playbook and includes custom playbooks', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'dsh-ws-playbooks-'))
    try {
      await mkdir(join(ws, 'skills', 'playbooks'), { recursive: true })
      await writeFile(join(ws, 'skills', 'playbooks', 'SKILL.md'), '---\nname: playbooks\n---\n', 'utf8')
      await writeFile(join(ws, 'skills', 'playbooks', 'bug-fix.md'), [
        '---',
        'id: bug-fix',
        'name: 自定义缺陷修复',
        'when: custom workspace bug fixes',
        'workspaceMode: in-place',
        '---',
        '1. **稳定复现** {#repro} (`bug-fix`, 只读): reproduce first.',
        '2. **修复与核验** {#fix} (`tdd`): patch cleanly.',
      ].join('\n'), 'utf8')
      await writeFile(join(ws, 'skills', 'playbooks', 'docs-release.md'), [
        '---',
        'name: 文档发布流程',
        'when: release documentation updates',
        'workspaceMode: in-place',
        '---',
        '1. **撰写** (`writing`): write docs.',
        '2. **核验** (`verify`, 只读): verify links.',
      ].join('\n'), 'utf8')

      const catalog = await discoverPlaybooks(ws)
      const bugFix = catalog.find(p => p.id === 'bug-fix')!
      expect(bugFix.source).toBe('workspace')
      expect(bugFix.name).toBe('自定义缺陷修复')
      expect(bugFix.workspaceMode).toBe('in-place')
      expect(catalog.some(p => p.id === 'docs-release' && p.source === 'workspace')).toBe(true)
      // Built-ins not overridden remain available.
      expect(catalog.some(p => p.id === 'code-dev' && p.source === 'builtin')).toBe(true)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  test('materializeCompiledPlaybook produces valid independent editable flows with unique names', async () => {
    const standalone = await mkdtemp(join(tmpdir(), 'dsh-mat-playbook-'))
    try {
      const compiled = await discoverAndCompileDefaultPlaybooks({ cwd: standalone, now: 100 })
      const bugFix = compiled.find(e => e.flow.id === 'bug-fix')!.flow
      const f1 = materializeCompiledPlaybook([], bugFix, 100, p => `${p}-1`)
      const f2 = materializeCompiledPlaybook([f1], bugFix, 200, p => `${p}-2`)
      expect(f1.name).toBe('通用缺陷修复')
      expect(f2.name).toBe('通用缺陷修复 (2)')
      expect(f1.workspaceMode).toBe('worktree')
      expect(f1.source?.ref).toBe('builtin:bug-fix.md')
      expect(() => validateFlows([f1, f2])).not.toThrow()
    } finally {
      await rm(standalone, { recursive: true, force: true })
    }
  })
})
