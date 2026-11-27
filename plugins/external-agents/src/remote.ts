/**
 * Typert Remote contribution for client <-> host agent selection, per-agent
 * permission modes, & session state.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { z } from 'zod'
import type {
  AgentDescriptor,
  SelectSessionAgentInput,
  SelectSessionPermissionInput,
  SessionAgentState,
  SessionCommandsResult,
  WorkspaceGitStatus,
} from './types.ts'

export const sessionAgentIdSchema = z.enum(['native', 'agy', 'claude-code', 'pi', 'codex'])

export const selectSessionAgentInputSchema = z.object({
  sessionId: z.string().min(1),
  agentId: sessionAgentIdSchema,
})

export const selectSessionPermissionInputSchema = z.object({
  sessionId: z.string().min(1),
  permissionMode: z.string().min(1),
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceExternalAgents {
    getCatalog: () => Promise<RemoteResult<{ readonly agents: readonly AgentDescriptor[] }>>
    getSessionState: (sessionId: string) => Promise<RemoteResult<SessionAgentState>>
    getSessionCommands: (sessionId: string) => Promise<RemoteResult<SessionCommandsResult>>
    getWorkspaceStatus: (sessionId: string) => Promise<RemoteResult<WorkspaceGitStatus>>
    selectSessionAgent: (input: SelectSessionAgentInput) => Promise<RemoteResult<SessionAgentState>>
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
