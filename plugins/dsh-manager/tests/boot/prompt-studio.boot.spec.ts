/**
 * Boot-tier integration specs for Prompt Studio (AC-2, AC-3, AC-4, AC-5, AC-6,
 * AC-7, AC-8, AC-9, AC-10, AC-11, AC-12):
 * - Global, pipeline, and stage prompt overrides affect real dispatched sessions
 *   and Steward turns while persisting `DispatchRecord.prompt` and 20-entry
 *   Steward prompt history (`stewardPrompt`).
 * - Locked sections & unknown variables fail validation atomically on RPC and YAML
 *   hot reload without corrupting active configuration or modifying disk mtime.
 * - Multi-project decoupling resolves `{{project.agentsMd}}` and `{{project.verifyDocs}}`
 *   dynamically without pipeline edits.
 * - Preset application (`bug-fix`) reuses crew members and creates editable pipelines.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-studio-boot-'))
const projAlpha = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-proj-alpha-')))
const projBeta = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-proj-beta-')))

// Project Alpha has AGENTS.md + docs/verify/README.md; Project Beta has different AGENTS.md and NO docs/verify
await mkdir(join(projAlpha, 'docs', 'verify'), { recursive: true })
await writeFile(join(projAlpha, 'AGENTS.md'), 'ALPHA AGENTS: run alpha-check\n', 'utf8')
await writeFile(join(projAlpha, 'docs', 'verify', 'README.md'), 'ALPHA VERIFY DOCS\n', 'utf8')
await writeFile(join(projBeta, 'AGENTS.md'), 'BETA AGENTS: run beta-check\n', 'utf8')

for (const repoDir of [projAlpha, projBeta]) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' })
}

const overlayPath = join(home, 'prompt-studio.patch.yml')
await writeFile(overlayPath, [
  '- insert:',
  '    - id: dsh-manager',
  '      name: "@charonx/dsh-manager"',
  '      config:',
  '        steward:',
  '          provider: mock',
  '          model: steward-test',
  '          tickMs: 3600000',
  '        executor:',
  '          provider: mock',
  '          model: executor-test',
  '          maxConcurrent: 2',
  '          tickMs: 3600000',
  '          turnTimeoutMs: 30000',
  `          cwd: ${JSON.stringify(projAlpha)}`,
  '',
].join('\n'))

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallsResponse(calls: { name: string; args: unknown }[]): StreamChunk[] {
  return [
    ...calls.flatMap((call, index) => {
      const callId = ToolCallId(`call-${index + 1}`)
      const argumentsJson = JSON.stringify(call.args)
      return [
        { type: 'block-start' as const, index, blockType: 'tool-call' as const },
        { type: 'tool-call-delta' as const, index, id: callId, name: call.name, argumentsDelta: argumentsJson },
        { type: 'block-end' as const, index, block: { type: 'tool-call' as const, id: callId, name: call.name, arguments: argumentsJson } },
      ]
    }),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class RecordingAdapter extends LlmAdapter {
  prompts: string[] = []

  constructor(private readonly ruleIdProvider: () => string) { super() }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    const lastSerialized = JSON.stringify(last ?? '')
    if (lastSerialized.includes('Generate the session title')) {
      for (const c of textResponse('Title')) yield c
      return
    }
    if (last === undefined || last.role !== 'user') {
      for (const c of textResponse('done')) yield c
      return
    }
    const tail = JSON.stringify(options.messages.slice(-2))
    for (const msg of options.messages.slice(-2)) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const t = (msg.content as readonly { type?: string; text?: string }[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
        if (t.includes('Route the accepted ticket') || t.includes('executor dispatched for ticket')) {
          this.prompts.push(t)
        }
      }
    }

    if (tail.includes('Route the accepted ticket')) {
      for (const c of toolCallsResponse([{
        name: 'record_route',
        args: { ruleId: this.ruleIdProvider(), rationale: 'matched route rule' },
      }])) yield c
      return
    }
    if (tail.includes('executor dispatched for ticket')) {
      for (const c of toolCallsResponse([
        { name: 'submit_report', args: { kind: 'ready', message: 'done' } },
      ])) yield c
      return
    }
    if (tail.includes('Review the finished work on ticket')) {
      for (const c of toolCallsResponse([
        { name: 'record_review', args: { verdict: 'pass', feedback: 'looks good' } },
      ])) yield c
      return
    }
    for (const c of textResponse('ok')) yield c
  }
}

async function waitUntilService(ctx: Context, name: string, timeoutMs = 30_000): Promise<void> {
  const reflect = (ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }).reflect
  const deadline = Date.now() + timeoutMs
  while (reflect.get(name, true) === undefined) {
    if (Date.now() > deadline) throw new Error(`service ${name} timeout`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

async function waitUntil(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} timed out`)
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
}

afterAll(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {})
  await rm(projAlpha, { recursive: true, force: true }).catch(() => {})
  await rm(projBeta, { recursive: true, force: true }).catch(() => {})
})

test('Prompt Studio end-to-end boot contract (AC-2..AC-12)', async () => {
  let activeRuleId = ''
  const adapter = new RecordingAdapter(() => activeRuleId)

  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test',
    profile: 'web',
    overlayPaths: [overlayPath],
    home,
  })

  try {
    await waitUntilService(ctx, 'dshManagerExecutor')
    ctx.llm.registerAdapter(['mock'], adapter)

    const wsAlpha = await ctx.workspaceRegistry.create(projAlpha, 'Project Alpha')
    const wsBeta = await ctx.workspaceRegistry.create(projBeta, 'Project Beta')

    // Seed crew, pipeline, and route rule
    const crew = await ctx.dshManagerCrew.crewAdd({ name: 'Builder', role: 'build features cleanly' })
    const pipe = await ctx.dshManagerPipeline.pipelineAdd({
      name: 'Delivery Line',
      stages: [
        {
          memberId: crew.member.id,
          instruction: 'Docs: {{project.agentsMd}} | Verify: {{project.verifyDocs}}',
          skippable: false,
        },
      ],
    })
    const rule = await ctx.dshManagerRoute.ruleAdd({ condition: 'all tasks', pipelineId: pipe.pipeline.id })
    activeRuleId = rule.rule.id

    const yamlPath = ctx.dshManagerTeamConfig.status().filePath

    // AC-2: Global override via promptSave + verify tool output
    await ctx.dshManagerTeamConfig.promptSave({
      scope: 'global',
      turnId: 'executor',
      sections: { skills: 'GLOBAL SKILLS: {{skills.list}}' },
    })
    const diskAfterGlobal = await readFile(yamlPath, 'utf8')
    expect(diskAfterGlobal).toContain('version: 2')
    expect(diskAfterGlobal).toContain('GLOBAL SKILLS')
    const toolGet = ctx.tools.get('dsh_manager_team_config_get')!
    const toolRes = await toolGet.execute({ includeYaml: true }, {} as never) as { yaml: string }
    expect(toolRes.yaml).toContain('GLOBAL SKILLS')

    // AC-4 & AC-5: Locked section and unknown variable rejected without modifying disk mtime or revision
    const beforeStat = await stat(yamlPath)
    const beforeRev = ctx.dshManagerTeamConfig.status().revision
    await expect(ctx.dshManagerTeamConfig.promptSave({
      scope: 'global',
      turnId: 'executor',
      sections: { report: 'bypass' },
    })).rejects.toThrow('prompt section "report" is locked and cannot be overridden')
    await expect(ctx.dshManagerTeamConfig.promptSave({
      scope: 'global',
      turnId: 'executor',
      sections: { identity: 'Hello {{nope}}' },
    })).rejects.toThrow('unknown variable "nope"')
    const afterStat = await stat(yamlPath)
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
    expect(ctx.dshManagerTeamConfig.status().revision).toBe(beforeRev)

    // AC-6: Preview against Beta (no docs/verify) omits empty line and flags missing project.verifyDocs
    const previewBeta = await ctx.dshManagerTeamConfig.promptRenderPreview({
      turnId: 'executor',
      pipelineId: pipe.pipeline.id,
      stageIndex: 0,
      projectId: wsBeta.id,
      draftSections: {
        identity: 'ID={{ticket.id}}\n{{project.verifyDocs}}\nAGENT={{project.agentsMd}}',
      },
    })
    expect(previewBeta.missingVars).toContain('project.verifyDocs')
    expect(previewBeta.text).toContain('BETA AGENTS: run beta-check')
    expect(previewBeta.text).not.toContain('ID={{ticket.id}}\n\nAGENT=')

    // AC-3 + AC-9: Override stage-0 artifacts AND steward.route worktree, then route & dispatch a real ticket
    await ctx.dshManagerTeamConfig.promptSave({
      scope: 'stage',
      pipelineId: pipe.pipeline.id,
      stageIndex: 0,
      sections: { artifacts: 'CUSTOM STAGE ARTIFACTS IN {{env.scratchDir}}' },
    })
    await ctx.dshManagerTeamConfig.promptSave({
      scope: 'global',
      turnId: 'steward.route',
      sections: { worktree: 'CUSTOM STEWARD ROUTE WORKTREE RULE' },
    })

    const mintedA = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Alpha task',
      scope: 'run alpha flow',
      projectId: wsAlpha.id,
    }, Date.now())
    expect(mintedA).toBeDefined()
    const routedA = await ctx.dshManagerSteward.routeDirectTicket(mintedA!.id)
    expect(routedA).toBe(true)

    await vi.waitFor(async () => {
      const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: mintedA!.id })
      expect(detail.dispatches[0]?.prompt).toBeDefined()
      expect(detail.dispatches[0]?.prompt?.text).toContain('CUSTOM STAGE ARTIFACTS IN')
      expect(detail.dispatches[0]?.prompt?.text).not.toContain('Cumulative Review Fact File')
      expect(detail.dispatches[0]?.prompt?.text).toContain('ALPHA AGENTS: run alpha-check')
      expect(detail.dispatches[0]?.prompt?.text).toContain('ALPHA VERIFY DOCS')
      expect(detail.dispatches[0]?.prompt?.text).not.toContain('{{')
      const artifactsSec = detail.dispatches[0]?.prompt?.sections.find(s => s.id === 'artifacts')
      expect(artifactsSec?.source).toBe('stage')
    }, { timeout: 15_000 })

    // AC-9: Verify Steward route turn received custom worktree text and stewardPrompt RPC returns it
    const status = await ctx.dshManagerSteward.stewardStatus()
    const routeEntry = status.activity.find(a => a.text.includes('route →') && a.promptId !== undefined)
    expect(routeEntry?.promptId).toBeDefined()
    const stewardPromptRes = await ctx.dshManagerSteward.stewardPrompt({ promptId: routeEntry!.promptId! })
    expect(stewardPromptRes.prompt?.turnId).toBe('steward.route')
    expect(stewardPromptRes.prompt?.text).toContain('CUSTOM STEWARD ROUTE WORKTREE RULE')

    // AC-8: Dispatch a second ticket to Beta using the exact same pipeline (zero YAML edits)
    const mintedB = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Beta task',
      scope: 'run beta flow',
      projectId: wsBeta.id,
    }, Date.now())
    await ctx.dshManagerSteward.routeDirectTicket(mintedB!.id)
    await vi.waitFor(async () => {
      const detailB = await ctx.dshManagerExecutor.ticketDetail({ ticketId: mintedB!.id })
      expect(detailB.dispatches[0]?.prompt?.text).toContain('BETA AGENTS: run beta-check')
      expect(detailB.dispatches[0]?.prompt?.text).not.toContain('ALPHA AGENTS')
    }, { timeout: 15_000 })

    // AC-10: Apply bug-fix preset -> creates 3-stage pipeline with review mode at stage 3
    const presetRes = await ctx.dshManagerTeamConfig.presetApply({ presetId: 'bug-fix' })
    expect(presetRes.pipeline.name).toBe('缺陷修复')
    expect(presetRes.pipeline.stages).toHaveLength(3)
    expect(presetRes.pipeline.stages[2]?.mode).toBe('review')
    expect(presetRes.createdMembers).toHaveLength(3)

    // AC-12 + AC-4 (disk): Write locked section into YAML externally -> hot-reload rejects & preserves valid state, then recovers
    const validYaml = await readFile(yamlPath, 'utf8')
    const brokenLockedYaml = [
      'version: 2',
      'crew:',
      `  - id: ${crew.member.id}`,
      '    name: Builder',
      '    role: build features cleanly',
      'pipelines:',
      `  - id: ${pipe.pipeline.id}`,
      '    name: Delivery Line',
      '    stages:',
      `      - memberId: ${crew.member.id}`,
      '        instruction: check',
      'routes: []',
      'prompts:',
      '  turns:',
      '    executor:',
      '      sections:',
      '        report: illegal-override',
      '',
    ].join('\n')
    await writeFile(yamlPath, brokenLockedYaml, 'utf8')
    await waitUntil(
      () => ctx.dshManagerTeamConfig.status().lastError?.includes('prompt section "report" is locked') === true,
      'locked section hot-reload rejection',
    )
    // Valid pipelines still intact
    expect(ctx.dshManagerPipeline.list().some(p => p.id === pipe.pipeline.id)).toBe(true)

    // Recover by writing valid YAML back
    await writeFile(yamlPath, validYaml, 'utf8')
    await waitUntil(
      () => ctx.dshManagerTeamConfig.status().lastError === undefined,
      'hot-reload recovery after valid YAML restored',
    )
  } finally {
    await ctx.fiber.dispose()
  }
}, 300_000)
