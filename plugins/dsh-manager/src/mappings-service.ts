/**
 * Host service behind the project-mapping config: persisted external-object
 * → DSH-project mappings over storage-domain, validated against the harness
 * project list on every read and write — a mapping whose project vanished
 * surfaces an explicit error, never a silent skip (spec story 85).
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  mappingIdOf, mappingsDomain,
  type MappingId, type MappingRecord,
} from './mappings/mappings-domain.ts'
import { mappingRemoveInputSchema, mappingSetInputSchema, type MappingRemoveInput, type MappingSetInput, type MappingView, type ProjectRef } from './mappings/wire-types.ts'
import { MANUAL_CONNECTION_ID } from './sources/sources-domain.ts'

export type { MappingView, MappingSetInput, MappingRemoveInput, ProjectRef } from './mappings/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Project-mapping config API served to the Dsh Manager client. */
    dshManagerMappings: DshManagerMappings
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed mapping does not exist. */
    'dshManager/mapping-not-found': { readonly id: string }
    /** The mapping's target project does not exist in the harness list. */
    'dshManager/project-not-found': { readonly id: string }
  }
}

/** Mappings facet configuration. */
export interface MappingsConfig {}

export const MappingsConfig: z<MappingsConfig> = z.object({})

export class DshManagerMappings extends TypertRemoteService {
  /** Host services the mappings API reads. */
  static inject = ['storageDomain', 'workspaceRegistry', 'dshManagerConnections']

  static Config: z<MappingsConfig> = MappingsConfig

  private domain?: Domain<typeof mappingsDomain>

  constructor(ctx: Context, config: MappingsConfig) {
    super(ctx, 'dshManagerMappings', { namespace: 'dshManager' })
    void config
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(mappingsDomain)
    this.domain = domain
    this.ctx.effect(() => async () => { await domain.close() }, 'dsh-manager: close mappings domain')
  }

  /** The DSH projects the mapping picker offers, straight from the harness list. */
  @Remote
  async projectList(): Promise<{ readonly projects: readonly ProjectRef[] }> {
    return { projects: this.ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, name: workspace.title })) }
  }

  /** List every mapping with its validity against the current project list. */
  @Remote
  async mappingList(): Promise<{ readonly mappings: readonly MappingView[] }> {
    const mappings = [...this.domain!.table('mappings').entries()]
      .map(([, record]) => record)
    const views = await Promise.all(mappings.map(async record => ({
      ...this.viewOf(record),
      valid: await this.projectValid(record.projectId),
    })))
    for (const mapping of views) {
      if (!mapping.valid) {
        // Story 85: a dangling mapping is a loud error, never a silent skip.
        this.ctx.logger?.warn('mapping %s points at missing project %s', mapping.id, mapping.projectId)
      }
    }
    return { mappings: views }
  }

  /** Create or overwrite one external-object → project mapping. */
  @Remote
  async mappingSet(rawInput: MappingSetInput): Promise<MappingView> {
    const input = mappingSetInputSchema.parse(rawInput)
    // The manual pseudo-connection backs user input and may map to projects.
    if (input.connectionId !== MANUAL_CONNECTION_ID) {
      const connections = await this.ctx.dshManagerConnections.connectionList()
      if (!connections.connections.some(connection => connection.id === input.connectionId)) {
        throw new RemoteError('dshManager/connection-not-found', `connection ${input.connectionId} does not exist`, { id: input.connectionId })
      }
    }
    if (!(await this.projectValid(input.projectId))) {
      throw new RemoteError('dshManager/project-not-found', `project ${input.projectId} does not exist`, { id: input.projectId })
    }
    const record: MappingRecord = {
      id: mappingIdOf(input.connectionId, input.external),
      connectionId: input.connectionId,
      external: input.external,
      projectId: input.projectId,
      updatedAt: Date.now(),
    }
    await this.domain!.table('mappings').put(record.id as MappingId, record)
    return this.viewOf(record)
  }

  /** Remove one mapping. */
  @Remote
  async mappingRemove(rawInput: MappingRemoveInput): Promise<void> {
    const input = mappingRemoveInputSchema.parse(rawInput)
    this.requireRecord(input.id)
    await this.domain!.table('mappings').delete(input.id as MappingId)
  }

  /** The project one mapped external object belongs to, for host-internal reads. */
  projectOf(connectionId: string, external: string): string | undefined {
    return this.domain!.table('mappings').get(mappingIdOf(connectionId, external) as MappingId)?.projectId
  }

  private viewOf(record: MappingRecord): MappingView {
    return {
      id: record.id,
      connectionId: record.connectionId,
      external: record.external,
      projectId: record.projectId,
      updatedAt: record.updatedAt,
      valid: true,
    }
  }

  /** A mapping target is valid only while the project exists and its directory is present. */
  private async projectValid(projectId: string): Promise<boolean> {
    const workspace = this.ctx.workspaceRegistry.get(projectId as WorkspaceId)
    if (workspace === undefined) return false
    return await workspace.status() === 'ok'
  }

  private requireRecord(id: string): MappingRecord {
    const record = this.domain!.table('mappings').get(id as MappingId)
    if (record === undefined) {
      throw new RemoteError('dshManager/mapping-not-found', `mapping ${id} does not exist`, { id })
    }
    return record
  }
}

export default DshManagerMappings
