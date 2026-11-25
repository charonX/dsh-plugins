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
    await waitUntilService(ctx, 'dshManagerRoute')
    expect(ctx.dshManagerCrew.list().map(m => m.id)).toEqual(['crew-legacy-1'])
    expect(ctx.dshManagerPipeline.list().map(p => p.id)).toEqual(['pipe-legacy-1'])
    expect(ctx.dshManagerRoute.list().map(r => r.id)).toEqual(['route-legacy-1'])

    const yamlPath = join(migrateHome, 'dsh-manager', 'team-config.yaml')
    const initialYaml = await readFile(yamlPath, 'utf8')
    expect(initialYaml).toContain('Legacy Reviewer')
    expect(initialYaml).toContain('Legacy Pipe')
    expect(initialYaml).toContain('all MR tasks')

    // Mutate via service API and confirm YAML updates synchronously.
    await ctx.dshManagerRoute.ruleAdd({ condition: 'hotfix tasks', pipelineId: 'pipe-legacy-1' })
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
    await waitUntilService(ctx, 'dshManagerRoute')
    const yamlPath = ctx.dshManagerTeamConfig.status().filePath

    // 1. Seed valid YAML from external file write and wait for fs.watch hot reload.
    await writeFile(yamlPath, [
      'version: 1',
      'crew:',
      '  - id: arch',
      '    name: Architect',
      '    role: design deep modules',
      'pipelines:',
      '  - id: standard',
      '    name: Standard Line',
      '    stages:',
      '      - memberId: arch',
      '        instruction: draft architecture',
      'routes:',
      '  - id: r-feat',
      '    condition: feature work',
      '    pipelineId: standard',
      '',
    ].join('\n'), 'utf8')

    await waitUntil(
      () => ctx.dshManagerCrew.list().some(m => m.id === 'arch')
        && ctx.dshManagerPipeline.list().some(p => p.id === 'standard')
        && ctx.dshManagerRoute.list().some(r => r.id === 'r-feat'),
      'initial external YAML hot reload',
    )
    expect(ctx.dshManagerTeamConfig.status().lastError).toBeUndefined()
    const validRevision = ctx.dshManagerTeamConfig.status().revision

    // 2. Write broken reference (remove crew referenced by pipeline) -> keep previous valid state & surface error.
    await writeFile(yamlPath, [
      'version: 1',
      'crew: []',
      'pipelines:',
      '  - id: standard',
      '    name: Standard Line',
      '    stages:',
      '      - memberId: arch',
      '        instruction: draft architecture',
      'routes: []',
      '',
    ].join('\n'), 'utf8')

    await waitUntil(
      () => ctx.dshManagerTeamConfig.status().revision > validRevision
        && ctx.dshManagerTeamConfig.status().lastError !== undefined,
      'invalid YAML error capture',
    )
    expect(ctx.dshManagerTeamConfig.status().lastError).toContain('unknown crew member "arch"')
    expect(ctx.dshManagerCrew.list().map(m => m.id)).toEqual(['arch'])
    expect(ctx.dshManagerPipeline.list().map(p => p.id)).toEqual(['standard'])

    // 3. Fix YAML with updated role & extra stage -> error clears and new state activates.
    await writeFile(yamlPath, [
      'version: 1',
      'crew:',
      '  - id: arch',
      '    name: Architect v2',
      '    role: design deep modules v2',
      '  - id: qa',
      '    name: QA',
      '    role: verify edge cases',
      'pipelines:',
      '  - id: standard',
      '    name: Standard Line v2',
      '    stages:',
      '      - memberId: arch',
      '        instruction: draft architecture',
      '      - memberId: qa',
      '        instruction: run full e2e',
      'routes:',
      '  - id: r-feat',
      '    condition: feature work',
      '    pipelineId: standard',
      '',
    ].join('\n'), 'utf8')

    await waitUntil(
      () => ctx.dshManagerTeamConfig.status().lastError === undefined
        && ctx.dshManagerCrew.list().some(m => m.id === 'qa')
        && ctx.dshManagerPipeline.require('standard').stages.length === 2,
      'recovery hot reload after fixing YAML',
    )
    expect(ctx.dshManagerCrew.require('arch').name).toBe('Architect v2')
    expect(ctx.dshManagerPipeline.require('standard').name).toBe('Standard Line v2')
  } finally {
    await ctx.fiber.dispose()
  }
}, 300_000)
