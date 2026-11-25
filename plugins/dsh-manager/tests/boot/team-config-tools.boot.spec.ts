/**
 * Boot-tier integration spec for conversational & MCP team-config tools (Slice 3):
 * verifies `dsh_manager_team_config_get`, `dsh_manager_team_member_upsert`,
 * `dsh_manager_flow_config_upsert`, and `dsh_manager_team_config_replace`
 * mutate `team-config.yaml` atomically, reject invalid writes cleanly, and
 * hot-apply into DshManagerCrew / DshManagerPipeline / DshManagerRoute.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const toolsHome = await mkdtemp(join(tmpdir(), 'dsh-team-tools-'))

async function writeOverlay(home: string, port: number): Promise<string> {
  const overlayPath = join(home, 'team-tools.patch.yml')
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
    '      config:',
    '        steward:',
    '          tickMs: 3600000',
    '        executor:',
    '          tickMs: 3600000',
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

test('global dsh_manager_* team/flow tools read, upsert, replace atomically, and write team-config.yaml', async () => {
  const overlayPath = await writeOverlay(toolsHome, 3101)
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test',
    profile: 'web',
    overlayPaths: [overlayPath],
    home: toolsHome,
  })
  try {
    await waitUntilService(ctx, 'dshManagerRoute')

    const getTool = ctx.tools.get('dsh_manager_team_config_get')
    const memberTool = ctx.tools.get('dsh_manager_team_member_upsert')
    const flowTool = ctx.tools.get('dsh_manager_flow_config_upsert')
    const replaceTool = ctx.tools.get('dsh_manager_team_config_replace')
    expect(getTool).toBeDefined()
    expect(memberTool).toBeDefined()
    expect(flowTool).toBeDefined()
    expect(replaceTool).toBeDefined()

    // 1. Add crew member via tool with custom slug.
    const addedMember = await memberTool!.execute({
      action: 'add',
      memberId: 'coder-1',
      name: 'Coder One',
      role: 'write clean vertical slices',
      agentKind: 'claude-code',
    }, {} as never)
    expect(addedMember).toMatchObject({ ok: true, action: 'add', member: { id: 'coder-1', agentKind: 'claude-code' } })

    // 2. Add pipeline + route rule via flow tool.
    const addedPipe = await flowTool!.execute({
      target: 'pipeline',
      action: 'add',
      id: 'pipe-dev',
      name: 'Dev Line',
      stages: [{ memberId: 'coder-1', instruction: 'implement feature' }],
    }, {} as never)
    expect(addedPipe).toMatchObject({ ok: true, target: 'pipeline', record: { id: 'pipe-dev' } })

    const addedRoute = await flowTool!.execute({
      target: 'route',
      action: 'add',
      id: 'route-dev',
      condition: 'new feature requests',
      pipelineId: 'pipe-dev',
    }, {} as never)
    expect(addedRoute).toMatchObject({ ok: true, target: 'route', record: { id: 'route-dev' } })

    // 3. Guard: removing referenced member without force is rejected cleanly.
    const blockedRemove = await memberTool!.execute({ action: 'remove', memberId: 'coder-1' }, {} as never)
    expect(blockedRemove).toMatchObject({ ok: false })
    expect(ctx.dshManagerCrew.list()).toHaveLength(1)

    // 4. Replace with broken YAML fails atomically without losing existing valid state.
    const badReplace = await replaceTool!.execute({
      yaml: 'crew: []\npipelines:\n  - id: p\n    name: P\n    stages:\n      - memberId: missing\n',
    }, {} as never)
    expect(badReplace).toMatchObject({ ok: false })
    expect(ctx.dshManagerCrew.list().map(m => m.id)).toEqual(['coder-1'])

    // 5. Read back full snapshot + YAML.
    const snapshot = await getTool!.execute({ includeYaml: true }, {} as never) as {
      crew: unknown[]
      pipelines: unknown[]
      routes: unknown[]
      yaml: string
    }
    expect(snapshot.crew).toHaveLength(1)
    expect(snapshot.pipelines).toHaveLength(1)
    expect(snapshot.routes).toHaveLength(1)
    expect(snapshot.yaml).toContain('coder-1')

    const onDisk = await readFile(ctx.dshManagerTeamConfig.status().filePath, 'utf8')
    expect(onDisk).toContain('pipe-dev')
    expect(onDisk).toContain('route-dev')
  } finally {
    await ctx.fiber.dispose()
  }
}, 300_000)
