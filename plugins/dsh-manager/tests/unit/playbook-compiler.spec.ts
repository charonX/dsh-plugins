/** Unit tests for the one-shot Playbook -> Flow IR compiler & SHA-256 hash cache. */
import { describe, expect, test, vi } from 'vitest'
import { compilePlaybookToFlow } from '../../src/flow/playbook-compiler.ts'

describe('playbook-compiler', () => {
  test('compiles explicit frontmatter steps deterministically and hits hash cache on repeat', async () => {
    const content = [
      '---',
      'name: 知识创作剧本',
      'when: 写读书笔记、主题调研文章',
      'workspaceMode: in-place',
      'steps:',
      '  - id: outline',
      '    name: 资料梳理',
      '    skills: [how]',
      '    readOnly: true',
      '  - id: write',
      '    name: 起草正文',
      '    skills: [knowledge-writing]',
      '  - id: audit',
      '    name: 写作自检',
      '    readOnly: true',
      '    onFail: write',
      '---',
      '# 知识创作剧本',
    ].join('\n')

    const llmSpy = vi.fn()
    const first = await compilePlaybookToFlow({
      kind: 'skill',
      ref: 'knowledge-playbook',
      content,
      compileWithLlm: llmSpy,
      now: 100,
      idFactory: p => `${p}-1`,
    })
    expect(first.cacheHit).toBe(false)
    expect(first.method).toBe('frontmatter')
    expect(first.flow.workspaceMode).toBe('in-place')
    expect(first.flow.steps.map(s => s.id)).toEqual(['outline', 'write', 'audit'])
    expect(first.flow.steps[2]?.onFail).toBe('write')
    expect(llmSpy).not.toHaveBeenCalled()

    // Second compile with identical content hits cache immediately without LLM or re-parsing.
    const second = await compilePlaybookToFlow({
      kind: 'skill',
      ref: 'knowledge-playbook',
      content,
      existingFlow: first.flow,
      compileWithLlm: llmSpy,
    })
    expect(second.cacheHit).toBe(true)
    expect(second.method).toBe('cache')
    expect(second.flow).toBe(first.flow)
    expect(llmSpy).not.toHaveBeenCalled()
  })

  test('extracts ordered markdown steps, matches referenced skills, and wires review onFail', async () => {
    const bugFixPlaybook = [
      '### Bug fix',
      '',
      '1. Reproduce it yourself on the matching surface via `verify`.',
      '2. Root-cause fix: plan minimal fix and write failing-first tests with `tdd`.',
      '3. Independent review: verify read-only on the same surface with `code-review` and `verify`.',
      '4. Opening a PR via `ship-pr`.',
    ].join('\n')

    const res = await compilePlaybookToFlow({
      kind: 'file',
      ref: '/tmp/bug-fix.md',
      content: bugFixPlaybook,
      availableSkillNames: ['verify', 'tdd', 'code-review', 'ship-pr'],
      now: 200,
    })
    expect(res.method).toBe('markdown')
    expect(res.flow.steps).toHaveLength(4)
    expect(res.flow.steps[0]?.skills).toEqual(['verify'])
    expect(res.flow.steps[0]?.readOnly).toBe(true)
    expect(res.flow.steps[1]?.skills).toEqual(['tdd'])
    expect(res.flow.steps[2]?.skills).toEqual(['verify', 'code-review'])
    expect(res.flow.steps[2]?.readOnly).toBe(true)
    expect(res.flow.steps[2]?.onFail).toBe(res.flow.steps[1]?.id)
    expect(res.flow.steps[3]?.skills).toEqual(['ship-pr'])
  })

  test('preserves user agent and humanConfirm bindings across source hash updates', async () => {
    const v1 = '### Demo\n1. Gather context (`how`)\n2. Write draft\n'
    const first = await compilePlaybookToFlow({
      kind: 'skill',
      ref: 'demo',
      content: v1,
      availableSkillNames: ['how'],
      now: 100,
    })
    const customized = {
      ...first.flow,
      steps: first.flow.steps.map((s, idx) => idx === 1
        ? { ...s, agent: { kind: 'claude-code' as const, model: 'sonnet' }, humanConfirm: true }
        : s),
    }

    const v2 = '### Demo\n1. Gather context (`how`)\n2. Write draft carefully with references\n'
    const updated = await compilePlaybookToFlow({
      kind: 'skill',
      ref: 'demo',
      content: v2,
      availableSkillNames: ['how'],
      existingFlow: customized,
      now: 200,
    })
    expect(updated.cacheHit).toBe(false)
    expect(updated.flow.source?.hash).not.toBe(first.flow.source?.hash)
    expect(updated.flow.steps[1]?.agent).toEqual({ kind: 'claude-code', model: 'sonnet' })
    expect(updated.flow.steps[1]?.humanConfirm).toBe(true)
  })

  test('uses one-shot LLM extraction only for unstructured prose playbooks', async () => {
    const prose = 'Read the user notes carefully, synthesize insights, and produce a clean summary.'
    const llmSpy = vi.fn().mockResolvedValue(JSON.stringify({
      name: 'Insight Synthesis',
      when: 'Synthesize raw user notes',
      workspaceMode: 'in-place',
      steps: [
        { id: 'read', name: 'Read notes', skills: ['how'], readOnly: true },
        { id: 'write', name: 'Synthesize summary', skills: [] },
      ],
    }))

    const compiled = await compilePlaybookToFlow({
      kind: 'file',
      ref: 'prose.md',
      content: prose,
      availableSkillNames: ['how'],
      compileWithLlm: llmSpy,
    })
    expect(compiled.method).toBe('llm')
    expect(compiled.flow.steps).toHaveLength(2)
    expect(llmSpy).toHaveBeenCalledTimes(1)
  })
})
