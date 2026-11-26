/**
 * Boot-tier integration spec for DshManagerTeamConfig (Slice 1):
 * 1) One-time migration from legacy storage-domain tables into `team-config.yaml`
 * 2) Bidirectional sync when mutating through Crew / Pipeline / Route services
 * 3) External file edit hot reload via `fs.watch`
 * 4) All-or-nothing validation: invalid YAML / broken references keep the previous
 *    valid config in memory and recover cleanly once fixed.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const migrateHome = await mkdtemp(join(tmpdir(), 'dsh-team-migrate-'))
const watchHome = await mkdtemp(join(tmpdir(), 'dsh-team-watch-'))
const dirsToClean = [migrateHome, watchHome]

async function writeOverlay(home: string, port: number): Promise<string> {
  const overlayPath = join(home, 'team-config.patch.yml')
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
    if (Date.now() > deadline) throw new Error(`service ${name} did not become ready within ${timeoutMs}ms`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

async function waitUntil(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} timed out after ${timeoutMs}ms`)
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
}

afterAll(async () => {
  for (const dir of dirsToClean) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('migrates legacy storage-domain records to team-config.yaml and writes back mutations', async () => {
  const storageDir = join(migrateHome, 'storages')
  await mkdir(storageDir, { recursive: true })
  await writeFile(join(storageDir, 'dsh_manager_crew.json'), JSON.stringify({
    unit: { name: 'dsh_manager_crew', version: 1 },
    global: null,
    tables: {
      members: {
        'crew-legacy-1': {
          id: 'crew-legacy-1',
          name: 'Legacy Reviewer',
          role: 'reviews diffs carefully',
          enabled: true,
          createdAt: 100,
          updatedAt: 100,
        },
      },
    },
  }), 'utf8')
  await writeFile(join(storageDir, 'dsh_manager_pipeline.json'), JSON.stringify({
    unit: { name: 'dsh_manager_pipeline', version: 1 },
    global: null,
    tables: {
      pipelines: {
        'pipe-legacy-1': {
          id: 'pipe-legacy-1',
          name: 'Legacy Pipe',
          stages: [{ memberId: 'crew-legacy-1', instruction: 'review PR', skippable: false }],
          createdAt: 100,
          updatedAt: 100,
        },
      },
    },
  }), 'utf8')
  await writeFile(join(storageDir, 'dsh_manager_route.json'), JSON.stringify({
    unit: { name: 'dsh_manager_route', version: 1 },
    global: null,
    tables: {
      rules: {
        'route-legacy-1': {
          id: 'route-legacy-1',
          condition: 'all MR tasks',
          pipelineId: 'pipe-legacy-1',
          enabled: true,
          order: 0,
          createdAt: 100,
          updatedAt: 100,
        },
      },
    },
  }), 'utf8')

  const overlayPath = await writeOverlay(migrateHome, 3096)
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test',
    profile: 'web',
    overlayPaths: [overlayPath],
    home: migrateHome,
  })
  try {
    await waitUntilService(ctx, 'dshManagerFlow')
    const flows = ctx.dshManagerFlow.list()
    expect(flows.map(f => f.id)).toEqual(['pipe-legacy-1'])
    expect(flows[0]?.when).toContain('all MR tasks')
    expect(flows[0]?.steps[0]?.name).toBe('Legacy Reviewer')

    const yamlPath = join(migrateHome, 'dsh-manager', 'team-config.yaml')
    const initialYaml = await readFile(yamlPath, 'utf8')
    expect(initialYaml).toContain('Legacy Reviewer')
    expect(initialYaml).toContain('Legacy Pipe')
    expect(initialYaml).toContain('all MR tasks')

    // Mutate via service API and confirm v3 Flow IR YAML updates synchronously.
    await ctx.dshManagerFlow.flowAdd({
      name: 'Hotfix Flow',
      when: 'hotfix tasks',
      workspaceMode: 'worktree',
      steps: [{ id: 'fix', name: 'Hotfix', skills: ['tdd'], goal: 'Fix hotfix' }],
    })
    const updatedYaml = await readFile(yamlPath, 'utf8')
    expect(updatedYaml).toContain('hotfix tasks')
    expect(updatedYaml).toContain('Legacy Reviewer')
  } finally {
    await ctx.fiber.dispose()
  }
}, 300_000)

test('hot reloads external YAML edits, keeps last valid state on errors, and recovers', async () => {
  const overlayPath = await writeOverlay(watchHome, 3097)
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test',
    profile: 'web',
    overlayPaths: [overlayPath],
    home: watchHome,
  })
  try {
    await waitUntilService(ctx, 'dshManagerFlow')
    const yamlPath = ctx.dshManagerTeamConfig.status().filePath

    // 1. Seed valid Flow IR v3 YAML from external file write and wait for fs.watch hot reload.
    await writeFile(yamlPath, [
      'version: 3',
      'flows:',
      '  - id: standard',
      '    name: Standard Line',
      '    when: feature work',
      '    workspaceMode: in-place',
      '    enabled: true',
      '    steps:',
      '      - id: draft',
      '        name: Architect',
      '        skills:',
      '          - how',
      '        goal: draft architecture',
      '',
    ].join('\n'), 'utf8')

    await waitUntil(
      () => ctx.dshManagerFlow.list().some(f => f.id === 'standard' && f.steps[0]?.goal === 'draft architecture'),
      'initial external YAML hot reload',
    )
    expect(ctx.dshManagerTeamConfig.status().lastError).toBeUndefined()
    const validRevision = ctx.dshManagerTeamConfig.status().revision

    // 2. Write broken reference (`onFail` targeting missing step) -> keep previous valid state & surface error.
    await writeFile(yamlPath, [
      'version: 3',
      'flows:',
      '  - id: standard',
      '    name: Broken Line',
      '    when: feature work',
      '    workspaceMode: in-place',
      '    steps:',
      '      - id: draft',
      '        name: Architect',
      '        skills: []',
      '        onFail: arch',
      '',
    ].join('\n'), 'utf8')

    await waitUntil(
      () => ctx.dshManagerTeamConfig.status().revision > validRevision
        && ctx.dshManagerTeamConfig.status().lastError !== undefined,
      'invalid YAML error capture',
    )
    expect(ctx.dshManagerTeamConfig.status().lastError).toContain('arch')
    expect(ctx.dshManagerFlow.list().map(f => f.id)).toEqual(['standard'])
    expect(ctx.dshManagerFlow.require('standard').name).toBe('Standard Line')

    // 3. Fix YAML with valid v3 Flow IR & extra review step -> error clears and new state activates.
    await writeFile(yamlPath, [
      'version: 3',
      'flows:',
      '  - id: standard',
      '    name: Standard Line v2',
      '    when: feature work',
      '    workspaceMode: worktree',
      '    enabled: true',
      '    steps:',
      '      - id: draft',
      '        name: Architect v2',
      '        skills:',
      '          - how',
      '        goal: draft architecture',
      '      - id: qa',
      '        name: QA',
      '        skills:',
      '          - verify',
      '        readOnly: true',
      '        onFail: draft',
      '        goal: run full e2e',
      '',
    ].join('\n'), 'utf8')

    await waitUntil(
      () => ctx.dshManagerTeamConfig.status().lastError === undefined
        && ctx.dshManagerFlow.require('standard').steps.length === 2,
      'recovery hot reload after fixing YAML',
    )
    expect(ctx.dshManagerFlow.require('standard').name).toBe('Standard Line v2')
    expect(ctx.dshManagerFlow.require('standard').steps[0]?.name).toBe('Architect v2')
    expect(ctx.dshManagerFlow.require('standard').steps[1]?.onFail).toBe('draft')
  } finally {
    await ctx.fiber.dispose()
  }
}, 300_000)
