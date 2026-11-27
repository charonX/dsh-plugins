/**
 * Typert Remote contribution for client <-> host agent selection, per-agent
 * model & reasoning effort selection, permission modes, global CLI configuration,
 * and subscription quota refresh.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { z } from 'zod'
import type {
  AgentDescriptor,
  ExternalAgentId,
  ExternalAgentsConfigSnapshot,
  SelectSessionAgentInput,
  SelectSessionModelInput,
  SelectSessionPermissionInput,
  SessionAgentState,
  SessionCommandsResult,
  UpdateExternalAgentsConfigInput,
  WorkspaceGitStatus,
} from './types.ts'

export const externalAgentIdSchema = z.enum(['agy', 'claude-code', 'pi', 'codex'])
export const sessionAgentIdSchema = z.enum(['native', 'agy', 'claude-code', 'pi', 'codex'])

export const selectSessionAgentInputSchema = z.object({
  sessionId: z.string().min(1),
  agentId: sessionAgentIdSchema,
})

export const selectSessionModelInputSchema = z.object({
  sessionId: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().nullable().optional(),
})

export const selectSessionPermissionInputSchema = z.object({
  sessionId: z.string().min(1),
  permissionMode: z.string().min(1),
})

export const agentModelOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
})

export const externalAgentSettingsSchema = z.object({
  defaultModel: z.string().optional(),
  defaultReasoningEffort: z.string().optional(),
  customModels: z.array(agentModelOptionSchema).optional(),
})

export const refreshQuotaInputSchema = z.object({
  agentId: externalAgentIdSchema.optional(),
})

export const updateExternalAgentsConfigInputSchema = z.object({
  defaultAgent: sessionAgentIdSchema.optional(),
  agentId: externalAgentIdSchema.optional(),
  settings: externalAgentSettingsSchema.optional(),
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceExternalAgents {
    getCatalog: () => Promise<RemoteResult<{ readonly agents: readonly AgentDescriptor[] }>>
    getConfig: () => Promise<RemoteResult<ExternalAgentsConfigSnapshot>>
    updateConfig: (input: UpdateExternalAgentsConfigInput) => Promise<RemoteResult<ExternalAgentsConfigSnapshot>>
    refreshQuota: (input?: { readonly agentId?: ExternalAgentId }) => Promise<RemoteResult<{ readonly agents: readonly AgentDescriptor[] }>>
    getSessionState: (sessionId: string) => Promise<RemoteResult<SessionAgentState>>
    getSessionCommands: (sessionId: string) => Promise<RemoteResult<SessionCommandsResult>>
    getWorkspaceStatus: (sessionId: string) => Promise<RemoteResult<WorkspaceGitStatus>>
    selectSessionAgent: (input: SelectSessionAgentInput) => Promise<RemoteResult<SessionAgentState>>
    selectSessionModel: (input: SelectSessionModelInput) => Promise<RemoteResult<SessionAgentState>>
    selectSessionPermission: (input: SelectSessionPermissionInput) => Promise<RemoteResult<SessionAgentState>>
  }

  interface TypertRemoteNamespaceMap {
    externalAgents: TypertRemoteNamespaceExternalAgents
  }
}

export const TYPERT_REMOTE = createTypertRemoteInfo(
  {
    package: '@charonx/dsh-external-agents',
    methods: {
      'externalAgents/getCatalog': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'ExternalAgentCatalogResult',
          create: () => z.any(),
          decode: value => value as { readonly agents: readonly AgentDescriptor[] },
        },
      },
      'externalAgents/getConfig': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'ExternalAgentsConfigSnapshot',
          create: () => z.any(),
          decode: value => value as ExternalAgentsConfigSnapshot,
        },
      },
      'externalAgents/updateConfig': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'input',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'UpdateExternalAgentsConfigInput',
            create: () => updateExternalAgentsConfigInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'UpdateExternalAgentsConfigInput',
            create: () => updateExternalAgentsConfigInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ExternalAgentsConfigSnapshot',
          create: () => z.any(),
          decode: value => value as ExternalAgentsConfigSnapshot,
        },
      },
      'externalAgents/refreshQuota': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'input',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'RefreshQuotaInput',
            create: () => refreshQuotaInputSchema.optional(),
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'RefreshQuotaInput',
            create: () => refreshQuotaInputSchema.optional(),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ExternalAgentCatalogResult',
          create: () => z.any(),
          decode: value => value as { readonly agents: readonly AgentDescriptor[] },
        },
      },
      'externalAgents/getSessionState': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'sessionId',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'string',
            create: () => z.string().min(1),
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'string',
            create: () => z.string().min(1),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'SessionAgentState',
          create: () => z.any(),
          decode: value => value as SessionAgentState,
        },
      },
      'externalAgents/getSessionCommands': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'sessionId',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'string',
            create: () => z.string().min(1),
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'string',
            create: () => z.string().min(1),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'SessionCommandsResult',
          create: () => z.any(),
          decode: value => value as SessionCommandsResult,
        },
      },
      'externalAgents/getWorkspaceStatus': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'sessionId',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'string',
            create: () => z.string().min(1),
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'string',
            create: () => z.string().min(1),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'WorkspaceGitStatus',
          create: () => z.any(),
          decode: value => value as WorkspaceGitStatus,
        },
      },
      'externalAgents/selectSessionAgent': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'input',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'SelectSessionAgentInput',
            create: () => selectSessionAgentInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'SelectSessionAgentInput',
            create: () => selectSessionAgentInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'SessionAgentState',
          create: () => z.any(),
          decode: value => value as SessionAgentState,
        },
      },
      'externalAgents/selectSessionModel': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'input',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'SelectSessionModelInput',
            create: () => selectSessionModelInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'SelectSessionModelInput',
            create: () => selectSessionModelInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'SessionAgentState',
          create: () => z.any(),
          decode: value => value as SessionAgentState,
        },
      },
      'externalAgents/selectSessionPermission': {
        service: 'externalAgents',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'input',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'SelectSessionPermissionInput',
            create: () => selectSessionPermissionInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'SelectSessionPermissionInput',
            create: () => selectSessionPermissionInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'SessionAgentState',
          create: () => z.any(),
          decode: value => value as SessionAgentState,
        },
      },
    },
  },
  z,
)

export default TYPERT_REMOTE
