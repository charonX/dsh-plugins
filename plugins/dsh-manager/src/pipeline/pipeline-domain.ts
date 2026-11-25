/**
 * The pipeline domain: ordered stage sequences over storage-domain — the
 * persistence adapter behind the pipeline core (ADR-0003).
 */
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { pipelineRecord, type PipelineRecord } from './pipeline-core.ts'

/** Stable pipeline identity. */
export type PipelineId = Branded<'PipelineId'>

/** Durable pipeline state: one mutable record per pipeline. */
export const pipelineDomain = defineDomain({
  name: 'dsh_manager_pipeline',
  version: 1,
  tables: {
    pipelines: domainTable<PipelineId, PipelineRecord>(pipelineRecord),
  },
})
