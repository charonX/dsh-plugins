/**
 * Global DSH tools (`dsh_manager_*`) for inspecting and hot-updating team
 * (Crew) and flow (Pipeline + Route) configuration from any chat session or
 * bridged third-party CLI MCP client.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AGENT_KINDS, crewMember, type CrewMember } from '../crew/crew-core.ts'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
import { pipelineRecord, STAGE_MODES, type PipelineRecord, type PipelineStage } from '../pipeline/pipeline-core.ts'
import { routeRule, type RouteRule } from '../route/route-core.ts'
import {
  parseTeamConfigYaml,
  serializeTeamConfigYaml,
  type TeamConfigDocument,
  type TeamConfigStatusView,
} from './team-config-core.ts'

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
    description: 'Read current Dsh Manager team configuration (crew members, pipelines, route rules), file path, revision, and any hot-reload validation error.',
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
          crew: { type: 'array', items: { type: 'object', additionalProperties: true } },
          pipelines: { type: 'array', items: { type: 'object', additionalProperties: true } },
          routes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          yaml: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const crew = Array.isArray(value.crew) ? value.crew.length : 0
        const pipelines = Array.isArray(value.pipelines) ? value.pipelines.length : 0
        const routes = Array.isArray(value.routes) ? value.routes.length : 0
        const status = value.status as { filePath?: string; lastError?: string } | undefined
        const errSuffix = status?.lastError ? ` (lastError: ${status.lastError})` : ''
        return [{
          type: 'text',
          text: `team-config (${status?.filePath ?? ''}): ${crew} crew, ${pipelines} pipelines, ${routes} routes${errSuffix}`,
        }]
      },
    },
    execute(args) {
      const doc = store.snapshot()
      const status = store.status()
      return Promise.resolve({
        status: toJsonRecord(status),
        crew: toJsonRecordArray(doc.crew),
        pipelines: toJsonRecordArray(doc.pipelines),
        routes: toJsonRecordArray(doc.routes),
        ...(args.includeYaml === true ? { yaml: serializeTeamConfigYaml(doc) } : {}),
      })
    },
  })
}

function teamConfigReplaceTool(store: TeamConfigToolPort): ToolDefinition {
  return defineTool({
    name: 'dsh_manager_team_config_replace',
    description: 'Atomically validate, persist to team-config.yaml, and hot-apply team/flow configuration. Provide either raw `yaml` or structured `crew`/`pipelines`/`routes` arrays; any syntax, schema, or reference error rejects the write without losing the active config.',
    parameters: {
      yaml: {
        type: 'string',
        description: 'Full team-config.yaml content. Mutually exclusive with structured section fields.',
      },
      crew: {
        type: 'array',
        description: 'Replacement crew member array when updating structurally.',
        items: { type: 'object', additionalProperties: true },
      },
      pipelines: {
        type: 'array',
        description: 'Replacement pipeline array when updating structurally.',
        items: { type: 'object', additionalProperties: true },
      },
      routes: {
        type: 'array',
        description: 'Replacement route rule array when updating structurally.',
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
            counts: { crew: saved.crew.length, pipelines: saved.pipelines.length, routes: saved.routes.length },
          }
        }
        if (args.crew === undefined && args.pipelines === undefined && args.routes === undefined) {
          return { ok: false, error: 'provide either `yaml` or at least one of `crew`, `pipelines`, `routes`' }
        }
        const saved = await store.mutate((current) => {
          const mergedYaml = serializeTeamConfigYaml({
            version: 1,
            crew: (args.crew as readonly CrewMember[] | undefined) ?? current.crew,
            pipelines: (args.pipelines as readonly PipelineRecord[] | undefined) ?? current.pipelines,
            routes: (args.routes as readonly RouteRule[] | undefined) ?? current.routes,
          })
          return parseTeamConfigYaml(mergedYaml)
        })
        return {
          ok: true,
          status: toJsonRecord(store.status()),
          counts: { crew: saved.crew.length, pipelines: saved.pipelines.length, routes: saved.routes.length },
        }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  })
}

function teamMemberUpsertTool(store: TeamConfigToolPort): ToolDefinition {
  return defineTool({
    name: 'dsh_manager_team_member_upsert',
    description: 'Add, update, or remove a single Dsh Manager crew member and hot-apply immediately.',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'update', 'remove'], description: 'Operation to perform.' },
      memberId: { type: 'string', description: 'Member id (optional readable slug on add; required on update/remove).' },
      name: { type: 'string', description: 'Display name of the crew member.' },
      role: { type: 'string', description: 'Duty prompt carried with tasks dispatched to this member.' },
      agentKind: { type: 'string', enum: [...AGENT_KINDS], description: 'Execution backend (`builtin` clears an external CLI override).' },
      provider: { type: 'string', description: 'LLM provider override; pass empty string on update to clear override.' },
      model: { type: 'string', description: 'LLM model override; pass empty string on update to clear override.' },
      enabled: { type: 'boolean', description: 'Whether stages may dispatch to this member.' },
      force: { type: 'boolean', description: 'On remove: also prune pipeline stages referencing this member.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          member: { type: 'object', additionalProperties: true },
          removedId: { type: 'string' },
          status: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `crew ${String(value.action)} succeeded`
          : `crew ${String(value.action ?? '')} failed: ${String(value.error ?? 'unknown error')}`,
      }],
    },
    async execute(args) {
      const action = args.action as 'add' | 'update' | 'remove'
      try {
        if (action === 'add') {
          const memberId = typeof args.memberId === 'string' && args.memberId.trim() !== ''
            ? args.memberId.trim()
            : `crew-${crypto.randomUUID()}`
          const now = Date.now()
          const next = crewMember.parse({
            id: memberId,
            name: args.name,
            role: args.role,
            ...(args.agentKind !== undefined && args.agentKind !== 'builtin' ? { agentKind: args.agentKind } : {}),
            ...(typeof args.provider === 'string' && args.provider.trim() !== '' ? { provider: args.provider.trim() } : {}),
            ...(typeof args.model === 'string' && args.model.trim() !== '' ? { model: args.model.trim() } : {}),
            enabled: args.enabled ?? true,
            createdAt: now,
            updatedAt: now,
          })
          await store.mutate(doc => ({ ...doc, crew: [...doc.crew, next] }))
          return { ok: true, action, member: toJsonRecord(next), status: toJsonRecord(store.status()) }
        }

        const memberId = typeof args.memberId === 'string' ? args.memberId.trim() : ''
        if (memberId === '') return { ok: false, action, error: 'memberId is required' }

        if (action === 'update') {
          let updated: CrewMember | undefined
          await store.mutate(doc => {
            const existing = doc.crew.find(item => item.id === memberId)
            if (existing === undefined) throw new Error(`crew member "${memberId}" does not exist`)
            const draft: CrewMember = {
              ...existing,
              ...(typeof args.name === 'string' ? { name: args.name } : {}),
              ...(typeof args.role === 'string' ? { role: args.role } : {}),
              ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
              updatedAt: Date.now(),
            }
            if (args.agentKind !== undefined) {
              if (args.agentKind === 'builtin') delete draft.agentKind
              else draft.agentKind = args.agentKind
            }
            if (args.provider !== undefined) {
              if (args.provider.trim() === '') delete draft.provider
              else draft.provider = args.provider.trim()
            }
            if (args.model !== undefined) {
              if (args.model.trim() === '') delete draft.model
              else draft.model = args.model.trim()
            }
            updated = crewMember.parse(draft)
            return {
              ...doc,
              crew: doc.crew.map(item => (item.id === memberId ? updated! : item)),
            }
          })
          return { ok: true, action, member: toJsonRecord(updated), status: toJsonRecord(store.status()) }
        }

        // remove
        await store.mutate(doc => {
          if (!doc.crew.some(item => item.id === memberId)) {
            throw new Error(`crew member "${memberId}" does not exist`)
          }
          const refs = doc.pipelines
            .filter(p => p.stages.some(s => s.memberId === memberId))
            .map(p => p.id)
          if (refs.length > 0 && args.force !== true) {
            throw new Error(`crew member "${memberId}" is referenced by pipelines (${refs.join(', ')}); pass force: true to prune those stages`)
          }
          const now = Date.now()
          return {
            ...doc,
            crew: doc.crew.filter(item => item.id !== memberId),
            pipelines: doc.pipelines.map(p => {
              const stages = p.stages.filter(s => s.memberId !== memberId)
              return stages.length === p.stages.length ? p : { ...p, stages, updatedAt: now }
            }),
          }
        })
        return { ok: true, action, removedId: memberId, status: toJsonRecord(store.status()) }
      } catch (error) {
        return { ok: false, action, error: errorMessage(error) }
      }
    },
  })
}

function flowConfigUpsertTool(store: TeamConfigToolPort): ToolDefinition {
  return defineTool({
    name: 'dsh_manager_flow_config_upsert',
    description: 'Add, update, or remove a single Dsh Manager pipeline or route rule and hot-apply immediately (including in-flight flows).',
    parameters: {
      target: { type: 'string', required: true, enum: ['pipeline', 'route'], description: 'Target configuration entity type.' },
      action: { type: 'string', required: true, enum: ['add', 'update', 'remove'], description: 'Operation to perform.' },
      id: { type: 'string', description: 'Pipeline or route id (optional readable slug on add; required on update/remove).' },
      name: { type: 'string', description: 'Pipeline display name (when target is pipeline).' },
      stages: {
        type: 'array',
        description: 'Ordered pipeline stages (when target is pipeline).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            memberId: { type: 'string', required: true },
            instruction: { type: 'string' },
            skippable: { type: 'boolean' },
            skipLogic: { type: 'string' },
            mode: { type: 'string', enum: [...STAGE_MODES] },
          },
        },
      },
      condition: { type: 'string', description: 'Natural-language route condition (when target is route).' },
      pipelineId: { type: 'string', description: 'Target pipeline id (when target is route).' },
      enabled: { type: 'boolean', description: 'Whether the route rule is active.' },
      order: { type: 'integer', description: 'Route evaluation order (0-based).' },
      force: { type: 'boolean', description: 'On pipeline remove: also remove route rules referencing it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string' },
          action: { type: 'string' },
          record: { type: 'object', additionalProperties: true },
          removedId: { type: 'string' },
          status: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${String(value.target)} ${String(value.action)} succeeded`
          : `${String(value.target ?? '')} ${String(value.action ?? '')} failed: ${String(value.error ?? 'unknown error')}`,
      }],
    },
    async execute(args) {
      const target = args.target as 'pipeline' | 'route'
      const action = args.action as 'add' | 'update' | 'remove'
      try {
        if (target === 'pipeline') {
          if (action === 'add') {
            const id = typeof args.id === 'string' && args.id.trim() !== ''
              ? args.id.trim()
              : `pipe-${crypto.randomUUID()}`
            const rawStages = Array.isArray(args.stages) ? args.stages : []
            if (rawStages.length === 0) throw new Error('stages must contain at least one stage')
            const now = Date.now()
            const stages: PipelineStage[] = rawStages.map(stage => ({
              memberId: String((stage as { memberId?: unknown }).memberId ?? ''),
              instruction: typeof (stage as { instruction?: unknown }).instruction === 'string'
                ? (stage as { instruction: string }).instruction
                : '',
              skippable: (stage as { skippable?: unknown }).skippable === true,
              ...(typeof (stage as { skipLogic?: unknown }).skipLogic === 'string'
                && (stage as { skipLogic: string }).skipLogic.trim() !== ''
                ? { skipLogic: (stage as { skipLogic: string }).skipLogic }
                : {}),
              ...(typeof (stage as { mode?: unknown }).mode === 'string'
                && (STAGE_MODES as readonly string[]).includes((stage as { mode: string }).mode)
                ? { mode: (stage as { mode: PipelineStage['mode'] }).mode }
                : {}),
            }))
            const next = pipelineRecord.parse({
              id,
              name: args.name,
              stages,
              createdAt: now,
              updatedAt: now,
            })
            await store.mutate(doc => ({ ...doc, pipelines: [...doc.pipelines, next] }))
            return { ok: true, target, action, record: toJsonRecord(next), status: toJsonRecord(store.status()) }
          }

          const id = typeof args.id === 'string' ? args.id.trim() : ''
          if (id === '') return { ok: false, target, action, error: 'id is required' }

          if (action === 'update') {
            let updated: PipelineRecord | undefined
            await store.mutate(doc => {
              const existing = doc.pipelines.find(item => item.id === id)
              if (existing === undefined) throw new Error(`pipeline "${id}" does not exist`)
              const stages = args.stages === undefined
                ? existing.stages
                : args.stages.map(stage => ({
                  memberId: String((stage as { memberId?: unknown }).memberId ?? ''),
                  instruction: typeof (stage as { instruction?: unknown }).instruction === 'string'
                    ? (stage as { instruction: string }).instruction
                    : '',
                  skippable: (stage as { skippable?: unknown }).skippable === true,
                  ...(typeof (stage as { skipLogic?: unknown }).skipLogic === 'string'
                    && (stage as { skipLogic: string }).skipLogic.trim() !== ''
                    ? { skipLogic: (stage as { skipLogic: string }).skipLogic }
                    : {}),
                  ...(typeof (stage as { mode?: unknown }).mode === 'string'
                    && (STAGE_MODES as readonly string[]).includes((stage as { mode: string }).mode)
                    ? { mode: (stage as { mode: PipelineStage['mode'] }).mode }
                    : {}),
                }))
              updated = pipelineRecord.parse({
                ...existing,
                ...(typeof args.name === 'string' ? { name: args.name } : {}),
                stages,
                updatedAt: Date.now(),
              })
              return {
                ...doc,
                pipelines: doc.pipelines.map(item => (item.id === id ? updated! : item)),
              }
            })
            return { ok: true, target, action, record: toJsonRecord(updated), status: toJsonRecord(store.status()) }
          }

          // remove pipeline
          await store.mutate(doc => {
            if (!doc.pipelines.some(item => item.id === id)) {
              throw new Error(`pipeline "${id}" does not exist`)
            }
            const refs = doc.routes.filter(r => r.pipelineId === id).map(r => r.id)
            if (refs.length > 0 && args.force !== true) {
              throw new Error(`pipeline "${id}" is referenced by routes (${refs.join(', ')}); pass force: true to remove those routes`)
            }
            return {
              ...doc,
              pipelines: doc.pipelines.filter(item => item.id !== id),
              routes: doc.routes.filter(r => r.pipelineId !== id),
            }
          })
          return { ok: true, target, action, removedId: id, status: toJsonRecord(store.status()) }
        }

        // target === 'route'
        if (action === 'add') {
          const id = typeof args.id === 'string' && args.id.trim() !== ''
            ? args.id.trim()
            : `route-${crypto.randomUUID()}`
          const now = Date.now()
          let created: RouteRule | undefined
          await store.mutate(doc => {
            created = routeRule.parse({
              id,
              condition: args.condition,
              pipelineId: args.pipelineId,
              enabled: args.enabled ?? true,
              order: typeof args.order === 'number' ? args.order : doc.routes.length,
              createdAt: now,
              updatedAt: now,
            })
            return { ...doc, routes: [...doc.routes, created] }
          })
          return { ok: true, target, action, record: toJsonRecord(created), status: toJsonRecord(store.status()) }
        }

        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id === '') return { ok: false, target, action, error: 'id is required' }

        if (action === 'update') {
          let updated: RouteRule | undefined
          await store.mutate(doc => {
            const existing = doc.routes.find(item => item.id === id)
            if (existing === undefined) throw new Error(`route "${id}" does not exist`)
            updated = routeRule.parse({
              ...existing,
              ...(typeof args.condition === 'string' ? { condition: args.condition } : {}),
              ...(typeof args.pipelineId === 'string' ? { pipelineId: args.pipelineId } : {}),
              ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
              ...(typeof args.order === 'number' ? { order: args.order } : {}),
              updatedAt: Date.now(),
            })
            return {
              ...doc,
              routes: doc.routes.map(item => (item.id === id ? updated! : item)),
            }
          })
          return { ok: true, target, action, record: toJsonRecord(updated), status: toJsonRecord(store.status()) }
        }

        await store.mutate(doc => {
          if (!doc.routes.some(item => item.id === id)) {
            throw new Error(`route "${id}" does not exist`)
          }
          return { ...doc, routes: doc.routes.filter(item => item.id !== id) }
        })
        return { ok: true, target, action, removedId: id, status: toJsonRecord(store.status()) }
      } catch (error) {
        return { ok: false, target, action, error: errorMessage(error) }
      }
    },
  })
}

/** Build the team & flow configuration tools exposed on global `ctx.tools` (and bridged via MCP). */
export function createTeamConfigTools(store: TeamConfigToolPort): readonly ToolDefinition[] {
  return [
    teamConfigGetTool(store),
    teamConfigReplaceTool(store),
    teamMemberUpsertTool(store),
    flowConfigUpsertTool(store),
  ]
}
