/**
 * Main-seam spec: the project-mapping config API against the real harness
 * workspace registry — create, query, and the explicit failure of a mapping
 * whose project was deleted or whose directory vanished (spec story 85).
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const overlayPath = join(import.meta.dirname, '../../cordis.patch.yml')
const home = await mkdtemp(join(tmpdir(), 'dsh-mappings-boot-'))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-mappings-work-'))

test(
  'mappings validate against the harness project list and fail loudly when it breaks',
  async () => {
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })

    // Two real DSH projects: one that stays, one that will be deleted.
    const projectDir = join(scratch, 'alpha')
    const doomedDir = join(scratch, 'doomed')
    await mkdir(projectDir, { recursive: true })
    await mkdir(doomedDir, { recursive: true })
    const project = await ctx.workspaceRegistry.create(projectDir, 'alpha')
    const doomed = await ctx.workspaceRegistry.create(doomedDir, 'doomed')

    // An unknown connection is rejected up front.
    await expect(ctx.dshManagerMappings.mappingSet({
      connectionId: 'whatever', external: 'PROJ', projectId: 'no-such-project',
    })).rejects.toMatchObject({ code: 'dshManager/connection-not-found' })

    // A mapping onto an unknown project is rejected up front.
    await expect(ctx.dshManagerMappings.mappingSet({
      connectionId: 'no-such-connection', external: 'PROJ', projectId: project.id,
    })).rejects.toMatchObject({ code: 'dshManager/connection-not-found' })

    // Create one connection so the mapping can reference it.
    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl: 'https://jira.example.com',
      authMethod: 'pat', secret: 'pat-value',
    })

    await expect(ctx.dshManagerMappings.mappingSet({
      connectionId: connection.id, external: 'PROJ', projectId: 'no-such-project',
    })).rejects.toMatchObject({ code: 'dshManager/project-not-found' })

    const created = await ctx.dshManagerMappings.mappingSet({
      connectionId: connection.id, external: 'PROJ', projectId: project.id,
    })
    expect(created).toMatchObject({ connectionId: connection.id, external: 'PROJ', projectId: project.id, valid: true })

    // Mapping the same external object again overwrites instead of duplicating.
    await ctx.dshManagerMappings.mappingSet({
      connectionId: connection.id, external: 'PROJ', projectId: doomed.id,
    })
    const list = await ctx.dshManagerMappings.mappingList()
    expect(list.mappings).toHaveLength(1)
    expect(list.mappings[0]).toMatchObject({ external: 'PROJ', projectId: doomed.id, valid: true })

    // A second external object can map onto the same project.
    await ctx.dshManagerMappings.mappingSet({
      connectionId: connection.id, external: 'OTHER', projectId: doomed.id,
    })
    // And a mapping onto the surviving project for the invalidation checks.
    await ctx.dshManagerMappings.mappingSet({
      connectionId: connection.id, external: 'ALPHA', projectId: project.id,
    })
    const two = await ctx.dshManagerMappings.mappingList()
    expect(two.mappings).toHaveLength(3)

    // The picker offers the harness projects.
    const projects = await ctx.dshManagerMappings.projectList()
    expect(projects.projects.map(value => value.id).sort()).toEqual([doomed.id, project.id].sort())

    // Deleting the project surfaces an explicit invalid flag, not a skip.
    await ctx.workspaceRegistry.delete(doomed.id)
    const afterDelete = await ctx.dshManagerMappings.mappingList()
    expect(afterDelete.mappings).toHaveLength(3)
    expect(afterDelete.mappings.filter(mapping => !mapping.valid)).toHaveLength(2)
    expect(afterDelete.mappings.find(mapping => mapping.external === 'ALPHA')?.valid).toBe(true)

    // A vanished directory is invalid too, while the record stays.
    await rm(join(scratch, 'alpha'), { recursive: true, force: true })
    const afterVanish = await ctx.dshManagerMappings.mappingList()
    expect(afterVanish.mappings.find(mapping => mapping.external === 'ALPHA')?.valid).toBe(false)

    // Removal takes the mapping away.
    const alphaRow = afterVanish.mappings.find(row => row.external === 'ALPHA')
    await ctx.dshManagerMappings.mappingRemove({ id: alphaRow!.id })
    await expect(ctx.dshManagerMappings.mappingRemove({ id: alphaRow!.id }))
      .rejects.toMatchObject({ code: 'dshManager/mapping-not-found' })
    const afterRemove = await ctx.dshManagerMappings.mappingList()
    expect(afterRemove.mappings).toHaveLength(2)
    await ctx.fiber.dispose()
  },
  240_000,
)

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})
