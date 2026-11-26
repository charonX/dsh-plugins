/**
 * Global DSH tools (`dsh_manager_*`) for inspecting and hot-updating Flow IR
 * configuration from any chat session or bridged third-party CLI MCP client.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { flowDefSchema, type FlowDef } from '../flow/flow-ir.ts'
import {
  parseTeamConfigYaml,
  serializeTeamConfigYaml,
  type TeamConfigDocument,
  type TeamConfigStatusView,
} from './team-config-core.ts'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Minimal store port the team-config tools operate against. */
export interface TeamConfigToolPort {
  snapshot(): TeamConfigDocument
  status(): TeamConfigStatusView
  mutate(transform: (current: TeamConfigDocument) => TeamConfigDocument): Promise<TeamConfigDocument>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toJsonRecord(value: unknown): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

function toJsonRecordArray(values: readonly unknown[]): Record<string, JsonValue>[] {
  return JSON.parse(JSON.stringify(values)) as Record<string, JsonValue>[]
}

function teamConfigGetTool(store: TeamConfigToolPort): ToolDefinition {
  return defineTool({
    name: 'dsh_manager_team_config_get',
    description: 'Read current Dsh Manager Flow IR configuration (`flows`), file path, revision, and any hot-reload validation error.',
    parameters: {
      includeYaml: {
        type: 'boolean',
        description: 'When true, also include the serialized team-config.yaml text.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'object', additionalProperties: true },
          flows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          yaml: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const flows = Array.isArray(value.flows) ? value.flows.length : 0
        const status = value.status as { filePath?: string; lastError?: string } | undefined
        const errSuffix = status?.lastError ? ` (lastError: ${status.lastError})` : ''
        return [{
          type: 'text',
          text: `team-config (${status?.filePath ?? ''}): ${flows} flows${errSuffix}`,
        }]
      },
    },
    execute(args) {
      const doc = store.snapshot()
      const status = store.status()
      return Promise.resolve({
        status: toJsonRecord(status),
        flows: toJsonRecordArray(doc.flows),
        ...(args.includeYaml === true ? { yaml: serializeTeamConfigYaml(doc) } : {}),
      })
    },
  })
}

function teamConfigReplaceTool(store: TeamConfigToolPort): ToolDefinition {
  return defineTool({
    name: 'dsh_manager_team_config_replace',
    description: 'Atomically validate, persist to team-config.yaml, and hot-apply Flow IR configuration. Provide either raw `yaml` or a `flows` array.',
    parameters: {
      yaml: {
        type: 'string',
        description: 'Full team-config.yaml content (v3 Flow IR or legacy v1/v2 YAML).',
      },
      flows: {
        type: 'array',
        description: 'Replacement FlowDef array when updating structurally.',
        items: { type: 'object', additionalProperties: true },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'object', additionalProperties: true },
          counts: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `team-config updated (rev ${String((value.status as { revision?: unknown } | undefined)?.revision ?? '')})`
          : `team-config rejected: ${String(value.error ?? 'unknown error')}`,
      }],
    },
    async execute(args) {
      try {
        if (typeof args.yaml === 'string') {
          const parsed = parseTeamConfigYaml(args.yaml)
          const saved = await store.mutate(() => parsed)
          return {
            ok: true,
            status: toJsonRecord(store.status()),
            counts: { flows: saved.flows.length },
          }
        }
        if (!Array.isArray(args.flows)) {
          return { ok: false, error: 'provide either `yaml` or `flows`' }
        }
        const now = Date.now()
        const flows: FlowDef[] = args.flows.map((raw, idx) => {
          const obj = raw as Record<string, unknown>
          return flowDefSchema.parse({
            ...obj,
            createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : now + idx,
            updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : now + idx,
          })
        })
        const saved = await store.mutate(() => ({ version: 3, flows }))
        return {
          ok: true,
          status: toJsonRecord(store.status()),
          counts: { flows: saved.flows.length },
        }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  })
}

export function createTeamConfigTools(store: TeamConfigToolPort): readonly ToolDefinition[] {
  return [
    teamConfigGetTool(store),
    teamConfigReplaceTool(store),
  ]
}
