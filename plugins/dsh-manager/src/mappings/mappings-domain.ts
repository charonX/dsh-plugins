import { z } from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable mapping identity: one external object onto one DSH project. */
export type MappingId = Branded<'MappingId'>

/**
 * The external object a mapping addresses, keyed by connector family:
 * a Jira project key (e.g. `PROJ`) or a GitLab repository path
 * (e.g. `group/repo`). One external object maps to at most one project.
 */
export const externalKeySchema = z.object({
  /** The connection the external object lives under. */
  connectionId: z.string(),
  /** Connector-specific external key, opaque to the domain. */
  external: z.string().min(1),
})

/**
 * One persisted mapping row. `projectId` points into the harness project
 * list; a mapping whose project vanished stays stored and surfaces an
 * explicit error on read — never a silent skip.
 */
export const mappingRecord = z.object({
  /** `${connectionId}/${external}` — the natural identity of the pair. */
  id: z.string(),
  /** The connection the external object lives under. */
  connectionId: z.string(),
  /** Connector-specific external key, opaque to the domain. */
  external: z.string(),
  /** The DSH project the external object maps onto. */
  projectId: z.string(),
  /** Epoch millis when the mapping was created or last edited. */
  updatedAt: z.number(),
})

export type MappingRecord = z.infer<typeof mappingRecord>

/**
 * Durable external-object → DSH-project mappings. Uniqueness of one external
 * object is enforced at the id level: the record id is the composite of the
 * connection id and the external key, so a second mapping for the same pair
 * overwrites instead of duplicating.
 */
export const mappingsDomain = defineDomain({
  name: 'dsh_manager_mappings',
  version: 1,
  tables: {
    mappings: domainTable<MappingId, MappingRecord>(mappingRecord),
  },
})

/** The mapping id one external object lives under. */
export function mappingIdOf(connectionId: string, external: string): MappingId {
  return `${connectionId}/${external}` as MappingId
}
