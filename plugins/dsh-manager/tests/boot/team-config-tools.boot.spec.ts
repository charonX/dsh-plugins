/**
 * Boot-tier integration spec for global Flow IR config MCP tools:
 * - `dsh_manager_team_config_get`
 * - `dsh_manager_team_config_replace`
 * Plus `ctx.dshManagerFlow` CRUD persisting to `team-config.yaml`.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const toolsHome = await mkdtemp(join(tmpdir(), 'dsh-team-config-tools-'))

async function writeOverlay(home: string, port: number): Promise<string> {
  const overlayPath = join(home, 'tools.patch.yml')
  await writeFile(overlayPath, [
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${port}`,
    '    compression: gzip',
    '    compressionLevel: 1',
    '    compressionThresholdBytes: 1024',
    '- insert:',
    '    - id: dsh-manager',
    '      name: "@charonx/dsh-manager"',
    '      config: {}',
    '',
  ].join('\n'))
  return overlayPath
}

async function waitUntilService(ctx: Context, name: string, timeoutMs = 30_000): Promise<void> {
  const reflect = (ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }).reflect
  const deadline = Date.now() + timeoutMs
  while (reflect.get(name, true) === undefined) {
    if (Date.now() > deadline) throw new Error(`service ${name} timeout`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

afterAll(async () => {
  await rm(toolsHome, { recursive: true, force: true }).catch(() => {})
})

test('global MCP tools inspect and atomically replace Flow IR config while guarding broken updates', async () => {
  const overlayPath = await writeOverlay(toolsHome, 3106)
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test',
    profile: 'web',
    overlayPaths: [overlayPath],
    home: toolsHome,
  })
  try {
    await waitUntilService(ctx, 'dshManagerFlow')

    const getTool = ctx.tools.get('dsh_manager_team_config_get')
    const replaceTool = ctx.tools.get('dsh_manager_team_config_replace')
    expect(getTool).toBeDefined()
    expect(replaceTool).toBeDefined()

    const seededIds = ctx.dshManagerFlow.list().map(f => f.id)
    expect(seededIds).toEqual(['code-dev', 'bug-fix', 'knowledge-creation', 'refactoring'])

    // 1. Add a Flow IR entry via service API with third-party agent + skill mounts.
    const { flow } = await ctx.dshManagerFlow.flowAdd({
      name: 'Dev Line',
      when: 'new feature requests',
      workspaceMode: 'worktree',
      steps: [
        { id: 'plan', name: 'Plan', skills: ['how'], readOnly: true },
        { id: 'implement', name: 'Implement', skills: ['tdd'], agent: { kind: 'claude-code' } },
        { id: 'review', name: 'Review', skills: ['code-review'], readOnly: true, onFail: 'implement' },
      ],
    })
    expect(flow).toMatchObject({ name: 'Dev Line', workspaceMode: 'worktree' })
    expect(ctx.dshManagerFlow.list()).toHaveLength(seededIds.length + 1)

    // 2. Replace with broken Flow IR (dangling onFail step id) fails atomically without losing existing valid state.
    const badReplace = await replaceTool!.execute({
      yaml: [
        'version: 3',
        'flows:',
        '  - id: broken',
        '    name: Broken',
        '    when: any',
        '    workspaceMode: in-place',
        '    steps:',
        '      - id: s1',
        '        name: Step 1',
        '        skills: []',
        '        onFail: nonexistent',
        '',
      ].join('\n'),
    }, {} as never)
    expect(badReplace).toMatchObject({ ok: false })
    expect(ctx.dshManagerFlow.list().map(f => f.id)).toEqual([...seededIds, flow.id])

    // 3. Replace structurally with valid flows array succeeds and persists to disk.
    const goodReplace = await replaceTool!.execute({
      flows: [
        {
          id: 'flow-knowledge',
          name: 'Knowledge Writing',
          when: 'essay and docs creation',
          workspaceMode: 'in-place',
          enabled: true,
          steps: [
            { id: 'outline', name: 'Outline', skills: ['how'], readOnly: true },
            { id: 'draft', name: 'Draft', skills: [] },
          ],
        },
      ],
    }, {} as never)
    expect(goodReplace).toMatchObject({ ok: true, counts: { flows: 1 } })

    // 4. Read back full snapshot + YAML.
    const snapshot = await getTool!.execute({ includeYaml: true }, {} as never) as {
      flows: unknown[]
      yaml: string
    }
    expect(snapshot.flows).toHaveLength(1)
    expect(snapshot.yaml).toContain('flow-knowledge')

    const onDisk = await readFile(ctx.dshManagerTeamConfig.status().filePath, 'utf8')
    expect(onDisk).toContain('flow-knowledge')
    expect(onDisk).toContain('in-place')
  } finally {
    await ctx.fiber.dispose()
  }
}, 300_000)
