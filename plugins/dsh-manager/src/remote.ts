/**
 * Hand-written Remote contribution for the Dsh Manager APIs.
 *
 * It follows the generated `typert.remote-client.js` artifact shape exactly
 * (see the harness generator's emitter); the generator takes over this file
 * once the API surface grows and the repository carries the workspace layout
 * the generator requires. The host serves these methods through the
 * gateway's SRC fallback, which reads parameter names from the method
 * signatures; the codecs here shape the client's named input and results.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { z } from 'zod'
import {
  boardFilterSchema,
  closeTicketInputSchema,
  ticketDependenciesInputSchema,
  type BoardFilter,
  type CloseTicketInput,
  type TicketDependenciesInput,
} from './board/wire-types.ts'
import type { BoardSummary, TicketView } from './board-domain.ts'
import {
  connectionAddInputSchema,
  connectionCredentialInputSchema,
  connectionUpdateInputSchema,
  type ConnectivityResult,
  type ConnectionAddInput, type ConnectionCredentialInput, type ConnectionUpdateInput, type ConnectionView,
} from './connections/wire-types.ts'
import { manualInputSchema, type ManualInput } from './sources/wire-types.ts'
import { attentionAnswerInputSchema, attentionListInputSchema, type AttentionAnswerInput, type AttentionListInput, type AttentionView } from './attention/wire-types.ts'
import type { NotificationView } from './notifications/notification-core.ts'
import {
  dispatchCancelInputSchema,
  dispatchListInputSchema,
  dispatchTicketInputSchema,
  ticketChangeDiffInputSchema,
  ticketDetailInputSchema,
  type DispatchCancelInput, type DispatchListInput, type DispatchTicketInput, type DispatchView,
  type FileDiffView, type TicketChangeDiffInput, type TicketDetailInput, type TicketDetailView,
  type WorktreeInspectionView,
} from './dispatch/wire-types.ts'
import { evalListInputSchema, acceptCandidateInputSchema, type AcceptCandidateInput, type CandidateView, type EvalListInput, type EvalRecordView, type StewardStatusView } from './evals/wire-types.ts'
import { uiSettingsUpdateInputSchema, type UiSettingsUpdateInput, type UiSettingsView } from './settings/wire-types.ts'
import {
  imSettingsUpdateInputSchema,
  imTestSendInputSchema,
  type ImSettingsSnapshotView,
  type ImSettingsUpdateInput,
  type ImTestSendInput,
} from './im/wire-types.ts'
import {
  agentKindOptionsInputSchema,
  crewInputSchema, crewMemberIdSchema, crewUpdateInputSchema,
  type AgentKindOption, type AgentKindOptionsInput,
  type CrewInput, type CrewMemberIdInput, type CrewMemberView, type CrewUpdateInput, type ModelProviderOptions,
} from './crew/wire-types.ts'
import type { TeamConfigStatusView } from './team-config/team-config-core.ts'
import { pipelineIdSchema, pipelineInputSchema, pipelineUpdateInputSchema, type PipelineIdInput, type PipelineInput, type PipelineUpdateInput, type PipelineView } from './pipeline/wire-types.ts'
import { routeIdSchema, routeInputSchema, routeUpdateInputSchema, type RouteIdInput, type RouteInput, type RouteRuleView, type RouteUpdateInput } from './route/wire-types.ts'
import { policyDiffInputSchema, policyUpdateInputSchema, type PolicyDiff, type PolicyDiffInput, type PolicyRecord, type PolicyUpdateInput } from './policy/wire-types.ts'
import type { FlowTimelineView } from './flow/flow-core.ts'
import {
  mappingRemoveInputSchema,
  mappingSetInputSchema,
  type MappingRemoveInput, type MappingSetInput, type MappingView, type ProjectRef,
} from './mappings/wire-types.ts'
import {
  sourceAddInputSchema,
  sourceIdInputSchema,
  sourceUpdateInputSchema,
  triggerListInputSchema,
  type PollOutcome,
  type SourceAddInput, type SourceIdInput, type SourceUpdateInput, type SourceView,
  type ThreadView, type TriggerView,
} from './sources/wire-types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  /** Client-facing signatures of the dshManager namespace. */
  interface TypertRemoteNamespaceDshManager {
    summary: (input?: BoardFilter) => Promise<RemoteResult<BoardSummary>>
    ticketList: (input?: BoardFilter) => Promise<RemoteResult<{ readonly tickets: readonly TicketView[] }>>
    setTicketDependencies: (input: TicketDependenciesInput) => Promise<RemoteResult<{ readonly ticket: TicketView }>>
    closeTicket: (input: CloseTicketInput) => Promise<RemoteResult<{ readonly ticket: TicketView }>>
    connectionList: () => Promise<RemoteResult<{ readonly connections: readonly ConnectionView[] }>>
    connectionAdd: (input: ConnectionAddInput) => Promise<RemoteResult<ConnectionView>>
    connectionUpdate: (input: ConnectionUpdateInput) => Promise<RemoteResult<ConnectionView>>
    connectionTest: (id: string) => Promise<RemoteResult<ConnectivityResult>>
    connectionUpdateCredential: (input: ConnectionCredentialInput) => Promise<RemoteResult<ConnectionView>>
    connectionDeleteInfo: (id: string) => Promise<RemoteResult<{ sources: number; mappings: number }>>
    connectionRemove: (id: string) => Promise<RemoteResult<void>>
    projectList: () => Promise<RemoteResult<{ readonly projects: readonly ProjectRef[] }>>
    mappingList: () => Promise<RemoteResult<{ readonly mappings: readonly MappingView[] }>>
    mappingSet: (input: MappingSetInput) => Promise<RemoteResult<MappingView>>
    mappingRemove: (input: MappingRemoveInput) => Promise<RemoteResult<void>>
    sourceList: () => Promise<RemoteResult<{ readonly sources: readonly SourceView[] }>>
    sourceAdd: (input: SourceAddInput) => Promise<RemoteResult<SourceView>>
    sourceUpdate: (input: SourceUpdateInput) => Promise<RemoteResult<SourceView>>
    sourcePoll: (input: SourceIdInput) => Promise<RemoteResult<PollOutcome>>
    sourceRemove: (input: SourceIdInput) => Promise<RemoteResult<void>>
    threadList: () => Promise<RemoteResult<{ readonly threads: readonly ThreadView[] }>>
    triggerList: (input: { readonly threadId: string }) => Promise<RemoteResult<{ readonly triggers: readonly TriggerView[] }>>
    evalList: (input: EvalListInput) => Promise<RemoteResult<{ readonly evals: readonly EvalRecordView[] }>>
    candidateList: () => Promise<RemoteResult<{ readonly candidates: readonly CandidateView[] }>>
    acceptCandidate: (input: AcceptCandidateInput) => Promise<RemoteResult<void>>
    evalRequeue: (input: AcceptCandidateInput) => Promise<RemoteResult<void>>
    manualInput: (input: ManualInput) => Promise<RemoteResult<{ readonly threadId: string }>>
    dispatchTicket: (input: DispatchTicketInput) => Promise<RemoteResult<DispatchView>>
    dispatchList: (input: DispatchListInput) => Promise<RemoteResult<{ readonly dispatches: readonly DispatchView[] }>>
    dispatchCancel: (input: DispatchCancelInput) => Promise<RemoteResult<{ readonly cancelled: boolean; readonly dispatch: DispatchView }>>
    ticketDetail: (input: TicketDetailInput) => Promise<RemoteResult<TicketDetailView>>
    ticketChangeDiff: (input: TicketChangeDiffInput) => Promise<RemoteResult<{ readonly diff?: FileDiffView }>>
    ticketWorktree: (input: TicketDetailInput) => Promise<RemoteResult<{ readonly worktree?: WorktreeInspectionView }>>
    ticketWorktreeRemove: (input: TicketDetailInput) => Promise<RemoteResult<{ readonly removed: boolean }>>
    flowTimeline: (input: TicketDetailInput) => Promise<RemoteResult<FlowTimelineView | undefined>>
    attentionList: (input?: AttentionListInput) => Promise<RemoteResult<{ readonly attentions: readonly AttentionView[] }>>
    answerAttention: (input: AttentionAnswerInput) => Promise<RemoteResult<AttentionView>>
    notificationList: () => Promise<RemoteResult<{ readonly notifications: readonly NotificationView[] }>>
    stewardStatus: () => Promise<RemoteResult<StewardStatusView>>
    uiSettings: () => Promise<RemoteResult<{ readonly settings: UiSettingsView }>>
    uiSettingsUpdate: (input: UiSettingsUpdateInput) => Promise<RemoteResult<{ readonly settings: UiSettingsView }>>
    imSettings: () => Promise<RemoteResult<ImSettingsSnapshotView>>
    imSettingsUpdate: (input: ImSettingsUpdateInput) => Promise<RemoteResult<ImSettingsSnapshotView>>
    imTestSend: (input?: ImTestSendInput) => Promise<RemoteResult<{ readonly sent: boolean; readonly error?: string }>>
    crewList: () => Promise<RemoteResult<{ readonly members: readonly CrewMemberView[] }>>
    teamConfigStatus: () => Promise<RemoteResult<TeamConfigStatusView>>
    teamConfigReload: () => Promise<RemoteResult<TeamConfigStatusView>>
    modelOptions: () => Promise<RemoteResult<{ readonly providers: readonly ModelProviderOptions[] }>>
    agentKindOptions: (input?: AgentKindOptionsInput) => Promise<RemoteResult<{ readonly kinds: readonly AgentKindOption[] }>>
    crewAdd: (input: CrewInput) => Promise<RemoteResult<{ readonly member: CrewMemberView }>>
    crewUpdate: (input: CrewUpdateInput) => Promise<RemoteResult<{ readonly member: CrewMemberView }>>
    crewRemove: (input: CrewMemberIdInput) => Promise<RemoteResult<{ readonly removed: boolean }>>
    pipelineList: () => Promise<RemoteResult<{ readonly pipelines: readonly PipelineView[] }>>
    pipelineAdd: (input: PipelineInput) => Promise<RemoteResult<{ readonly pipeline: PipelineView }>>
    pipelineUpdate: (input: PipelineUpdateInput) => Promise<RemoteResult<{ readonly pipeline: PipelineView }>>
    pipelineRemove: (input: PipelineIdInput) => Promise<RemoteResult<{ readonly removed: boolean }>>
    pipelineReferencesOf: (input: CrewMemberIdInput) => Promise<RemoteResult<{ readonly references: readonly string[] }>>
    ruleList: () => Promise<RemoteResult<{ readonly rules: readonly RouteRuleView[] }>>
    ruleAdd: (input: RouteInput) => Promise<RemoteResult<{ readonly rule: RouteRuleView }>>
    ruleUpdate: (input: RouteUpdateInput) => Promise<RemoteResult<{ readonly rule: RouteRuleView }>>
    ruleRemove: (input: RouteIdInput) => Promise<RemoteResult<{ readonly removed: boolean }>>
    ruleReferencesOfPipeline: (input: PipelineIdInput) => Promise<RemoteResult<{ readonly rules: readonly string[] }>>
    policyList: () => Promise<RemoteResult<{ readonly policies: readonly PolicyRecord[] }>>
    policyDiff: (input: PolicyDiffInput) => Promise<RemoteResult<{ readonly diff: PolicyDiff }>>
    policyUpdate: (input: PolicyUpdateInput) => Promise<RemoteResult<{ readonly policy: PolicyRecord }>>
  }
  interface TypertRemoteNamespaceMap {
    dshManager: TypertRemoteNamespaceDshManager
  }
}

/** Client-side Remote contribution mounted by the Dsh Manager client entry. */
export const TYPERT_REMOTE = createTypertRemoteInfo(
  {
    package: '@charonx/dsh-manager',
    methods: {
      'dshManager/summary': {
        service: 'dshManagerBoard',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'BoardFilter',
            create: () => boardFilterSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'BoardFilter',
            create: () => boardFilterSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'BoardSummary',
          create: () => z.any(),
          decode: value => value as BoardSummary,
        },
      },
      'dshManager/ticketList': {
        service: 'dshManagerBoard',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'BoardFilter',
            create: () => boardFilterSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'BoardFilter',
            create: () => boardFilterSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'TicketList',
          create: () => z.any(),
          decode: value => value as { readonly tickets: readonly TicketView[] },
        },
      },
      'dshManager/setTicketDependencies': {
        service: 'dshManagerBoard',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'TicketDependenciesInput',
            create: () => ticketDependenciesInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'TicketDependenciesInput',
            create: () => ticketDependenciesInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'SetTicketDependenciesResult',
          create: () => z.any(),
          decode: value => value as { readonly ticket: TicketView },
        },
      },
      'dshManager/closeTicket': {
        service: 'dshManagerBoard',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'CloseTicketInput',
            create: () => closeTicketInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'CloseTicketInput',
            create: () => closeTicketInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'CloseTicketResult',
          create: () => z.any(),
          decode: value => value as { readonly ticket: TicketView },
        },
      },
      'dshManager/connectionList': {
        service: 'dshManagerConnections',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'ConnectionsList',
          create: () => z.any(),
          decode: value => value as { readonly connections: readonly ConnectionView[] },
        },
      },
      'dshManager/connectionAdd': {
        service: 'dshManagerConnections',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'ConnectionAddInput',
            create: () => connectionAddInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'ConnectionAddInput',
            create: () => connectionAddInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ConnectionView',
          create: () => z.any(),
          decode: value => value as ConnectionView,
        },
      },
      'dshManager/connectionUpdate': {
        service: 'dshManagerConnections',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'ConnectionUpdateInput',
            create: () => connectionUpdateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'ConnectionUpdateInput',
            create: () => connectionUpdateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ConnectionView',
          create: () => z.any(),
          decode: value => value as ConnectionView,
        },
      },
      'dshManager/connectionTest': {
        service: 'dshManagerConnections',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'id',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'ConnectionId',
            create: () => z.string(),
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'ConnectionId',
            create: () => z.string(),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ConnectivityResult',
          create: () => z.any(),
          decode: value => value as ConnectivityResult,
        },
      },
      'dshManager/connectionUpdateCredential': {
        service: 'dshManagerConnections',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'ConnectionCredentialInput',
            create: () => connectionCredentialInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'ConnectionCredentialInput',
            create: () => connectionCredentialInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ConnectionView',
          create: () => z.any(),
          decode: value => value as ConnectionView,
        },
      },
      'dshManager/connectionDeleteInfo': {
        service: 'dshManagerConnections',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'id',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'ConnectionId',
            create: () => z.string(),
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'ConnectionId',
            create: () => z.string(),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ConnectionDeleteInfo',
          create: () => z.any(),
          decode: value => value as { sources: number; mappings: number },
        },
      },
      'dshManager/connectionRemove': {
        service: 'dshManagerConnections',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'id',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'ConnectionId',
            create: () => z.string(),
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'ConnectionId',
            create: () => z.string(),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'void',
          create: () => z.any(),
          decode: value => value as void,
        },
      },
      'dshManager/projectList': {
        service: 'dshManagerMappings',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'ProjectList',
          create: () => z.any(),
          decode: value => value as { readonly projects: readonly ProjectRef[] },
        },
      },
      'dshManager/mappingList': {
        service: 'dshManagerMappings',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'MappingList',
          create: () => z.any(),
          decode: value => value as { readonly mappings: readonly MappingView[] },
        },
      },
      'dshManager/mappingSet': {
        service: 'dshManagerMappings',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'MappingSetInput',
            create: () => mappingSetInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'MappingSetInput',
            create: () => mappingSetInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'MappingView',
          create: () => z.any(),
          decode: value => value as MappingView,
        },
      },
      'dshManager/mappingRemove': {
        service: 'dshManagerMappings',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'MappingRemoveInput',
            create: () => mappingRemoveInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'MappingRemoveInput',
            create: () => mappingRemoveInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'void',
          create: () => z.any(),
          decode: value => value as void,
        },
      },
      'dshManager/sourceList': {
        service: 'dshManagerSources',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'SourceList',
          create: () => z.any(),
          decode: value => value as { readonly sources: readonly SourceView[] },
        },
      },
      'dshManager/sourceAdd': {
        service: 'dshManagerSources',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'SourceAddInput',
            create: () => sourceAddInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'SourceAddInput',
            create: () => sourceAddInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'SourceView',
          create: () => z.any(),
          decode: value => value as SourceView,
        },
      },
      'dshManager/sourceUpdate': {
        service: 'dshManagerSources',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'SourceUpdateInput',
            create: () => sourceUpdateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'SourceUpdateInput',
            create: () => sourceUpdateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'SourceView',
          create: () => z.any(),
          decode: value => value as SourceView,
        },
      },
      'dshManager/sourcePoll': {
        service: 'dshManagerSources',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'SourceIdInput',
            create: () => sourceIdInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'SourceIdInput',
            create: () => sourceIdInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'PollOutcome',
          create: () => z.any(),
          decode: value => value as PollOutcome,
        },
      },
      'dshManager/sourceRemove': {
        service: 'dshManagerSources',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'SourceIdInput',
            create: () => sourceIdInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'SourceIdInput',
            create: () => sourceIdInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'void',
          create: () => z.any(),
          decode: value => value as void,
        },
      },
      'dshManager/threadList': {
        service: 'dshManagerSources',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'ThreadList',
          create: () => z.any(),
          decode: value => value as { readonly threads: readonly ThreadView[] },
        },
      },
      'dshManager/triggerList': {
        service: 'dshManagerSources',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'TriggerListInput',
            create: () => triggerListInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'TriggerListInput',
            create: () => triggerListInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'TriggerList',
          create: () => z.any(),
          decode: value => value as { readonly triggers: readonly TriggerView[] },
        },
      },
      'dshManager/evalList': {
        service: 'dshManagerSteward',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'EvalListInput',
            create: () => evalListInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'EvalListInput',
            create: () => evalListInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'EvalList',
          create: () => z.any(),
          decode: value => value as { readonly evals: readonly EvalRecordView[] },
        },
      },
      'dshManager/candidateList': {
        service: 'dshManagerSteward',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'CandidateList',
          create: () => z.any(),
          decode: value => value as { readonly candidates: readonly CandidateView[] },
        },
      },
      'dshManager/acceptCandidate': {
        service: 'dshManagerSteward',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'AcceptCandidateInput',
            create: () => acceptCandidateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'AcceptCandidateInput',
            create: () => acceptCandidateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'void',
          create: () => z.any(),
          decode: value => value as void,
        },
      },
      'dshManager/evalRequeue': {
        service: 'dshManagerSteward',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'AcceptCandidateInput',
            create: () => acceptCandidateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'AcceptCandidateInput',
            create: () => acceptCandidateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'void',
          create: () => z.any(),
          decode: value => value as void,
        },
      },
      'dshManager/manualInput': {
        service: 'dshManagerSources',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'ManualInput',
            create: () => manualInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'ManualInput',
            create: () => manualInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ManualThread',
          create: () => z.any(),
          decode: value => value as { readonly threadId: string },
        },
      },
      'dshManager/dispatchTicket': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'DispatchTicketInput',
            create: () => dispatchTicketInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'DispatchTicketInput',
            create: () => dispatchTicketInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'DispatchView',
          create: () => z.any(),
          decode: value => value as DispatchView,
        },
      },
      'dshManager/dispatchList': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'DispatchListInput',
            create: () => dispatchListInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'DispatchListInput',
            create: () => dispatchListInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'DispatchList',
          create: () => z.any(),
          decode: value => value as { readonly dispatches: readonly DispatchView[] },
        },
      },
      'dshManager/dispatchCancel': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'DispatchCancelInput',
            create: () => dispatchCancelInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'DispatchCancelInput',
            create: () => dispatchCancelInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'DispatchCancelResult',
          create: () => z.any(),
          decode: value => value as { readonly cancelled: boolean; readonly dispatch: DispatchView },
        },
      },
      'dshManager/ticketDetail': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'TicketDetailInput',
            create: () => ticketDetailInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'TicketDetailInput',
            create: () => ticketDetailInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'TicketDetailView',
          create: () => z.any(),
          decode: value => value as TicketDetailView,
        },
      },
      'dshManager/ticketChangeDiff': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'TicketChangeDiffInput',
            create: () => ticketChangeDiffInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'TicketChangeDiffInput',
            create: () => ticketChangeDiffInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'FileDiffView',
          create: () => z.any(),
          decode: value => value as { readonly diff?: FileDiffView },
        },
      },
      'dshManager/ticketWorktree': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'TicketDetailInput',
            create: () => ticketDetailInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'TicketDetailInput',
            create: () => ticketDetailInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'TicketWorktreeResult',
          create: () => z.any(),
          decode: value => value as { readonly worktree?: WorktreeInspectionView },
        },
      },
      'dshManager/ticketWorktreeRemove': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'TicketDetailInput',
            create: () => ticketDetailInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'TicketDetailInput',
            create: () => ticketDetailInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'TicketWorktreeRemoveResult',
          create: () => z.any(),
          decode: value => value as { readonly removed: boolean },
        },
      },
      'dshManager/flowTimeline': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'TicketDetailInput',
            create: () => ticketDetailInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'TicketDetailInput',
            create: () => ticketDetailInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'FlowTimelineView',
          create: () => z.any(),
          decode: value => value as FlowTimelineView | undefined,
        },
      },
      'dshManager/attentionList': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'AttentionListInput',
            create: () => attentionListInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'AttentionListInput',
            create: () => attentionListInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'AttentionList',
          create: () => z.any(),
          decode: value => value as { readonly attentions: readonly AttentionView[] },
        },
      },
      'dshManager/answerAttention': {
        service: 'dshManagerExecutor',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'AttentionAnswerInput',
            create: () => attentionAnswerInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'AttentionAnswerInput',
            create: () => attentionAnswerInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'AttentionView',
          create: () => z.any(),
          decode: value => value as AttentionView,
        },
      },
      'dshManager/notificationList': {
        service: 'dshManagerNotifications',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'NotificationList',
          create: () => z.any(),
          decode: value => value as { readonly notifications: readonly NotificationView[] },
        },
      },
      'dshManager/stewardStatus': {
        service: 'dshManagerSteward',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'StewardStatus',
          create: () => z.any(),
          decode: value => value as StewardStatusView,
        },
      },
      'dshManager/uiSettings': {
        service: 'dshManagerSettings',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'UiSettings',
          create: () => z.any(),
          decode: value => value as { readonly settings: UiSettingsView },
        },
      },
      'dshManager/uiSettingsUpdate': {
        service: 'dshManagerSettings',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'UiSettingsUpdateInput',
            create: () => uiSettingsUpdateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'UiSettingsUpdateInput',
            create: () => uiSettingsUpdateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'UiSettingsUpdateResult',
          create: () => z.any(),
          decode: value => value as { readonly settings: UiSettingsView },
        },
      },
      'dshManager/imSettings': {
        service: 'dshManagerIm',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'ImSettingsSnapshot',
          create: () => z.any(),
          decode: value => value as ImSettingsSnapshotView,
        },
      },
      'dshManager/imSettingsUpdate': {
        service: 'dshManagerIm',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'ImSettingsUpdateInput',
            create: () => imSettingsUpdateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'ImSettingsUpdateInput',
            create: () => imSettingsUpdateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ImSettingsUpdateResult',
          create: () => z.any(),
          decode: value => value as ImSettingsSnapshotView,
        },
      },
      'dshManager/imTestSend': {
        service: 'dshManagerIm',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'ImTestSendInput',
            create: () => imTestSendInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'ImTestSendInput',
            create: () => imTestSendInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'ImTestSendResult',
          create: () => z.any(),
          decode: value => value as { readonly sent: boolean; readonly error?: string },
        },
      },
      'dshManager/crewList': {
        service: 'dshManagerCrew',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'CrewList',
          create: () => z.any(),
          decode: value => value as { readonly members: readonly CrewMemberView[] },
        },
      },
      'dshManager/modelOptions': {
        service: 'dshManagerCrew',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'ModelOptions',
          create: () => z.any(),
          decode: value => value as { readonly providers: readonly ModelProviderOptions[] },
        },
      },
      'dshManager/agentKindOptions': {
        service: 'dshManagerCrew',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'AgentKindOptionsInput',
            create: () => agentKindOptionsInputSchema.optional(),
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'AgentKindOptionsInput',
            create: () => agentKindOptionsInputSchema.optional(),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'AgentKindOptions',
          create: () => z.any(),
          decode: value => value as { readonly kinds: readonly AgentKindOption[] },
        },
      },
      'dshManager/crewAdd': {
        service: 'dshManagerCrew',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'CrewInput',
            create: () => crewInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'CrewInput',
            create: () => crewInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'CrewAddResult',
          create: () => z.any(),
          decode: value => value as { readonly member: CrewMemberView },
        },
      },
      'dshManager/crewUpdate': {
        service: 'dshManagerCrew',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'CrewUpdateInput',
            create: () => crewUpdateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'CrewUpdateInput',
            create: () => crewUpdateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'CrewUpdateResult',
          create: () => z.any(),
          decode: value => value as { readonly member: CrewMemberView },
        },
      },
      'dshManager/crewRemove': {
        service: 'dshManagerCrew',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'CrewMemberIdInput',
            create: () => crewMemberIdSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'CrewMemberIdInput',
            create: () => crewMemberIdSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'CrewRemoveResult',
          create: () => z.any(),
          decode: value => value as { readonly removed: boolean },
        },
      },
      'dshManager/pipelineList': {
        service: 'dshManagerPipeline',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'PipelineList',
          create: () => z.any(),
          decode: value => value as { readonly pipelines: readonly PipelineView[] },
        },
      },
      'dshManager/pipelineAdd': {
        service: 'dshManagerPipeline',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'PipelineInput',
            create: () => pipelineInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'PipelineInput',
            create: () => pipelineInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'PipelineAddResult',
          create: () => z.any(),
          decode: value => value as { readonly pipeline: PipelineView },
        },
      },
      'dshManager/pipelineUpdate': {
        service: 'dshManagerPipeline',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'PipelineUpdateInput',
            create: () => pipelineUpdateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'PipelineUpdateInput',
            create: () => pipelineUpdateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'PipelineUpdateResult',
          create: () => z.any(),
          decode: value => value as { readonly pipeline: PipelineView },
        },
      },
      'dshManager/pipelineRemove': {
        service: 'dshManagerPipeline',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'PipelineIdInput',
            create: () => pipelineIdSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'PipelineIdInput',
            create: () => pipelineIdSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'PipelineRemoveResult',
          create: () => z.any(),
          decode: value => value as { readonly removed: boolean },
        },
      },
      'dshManager/pipelineReferencesOf': {
        service: 'dshManagerPipeline',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'CrewMemberIdInput',
            create: () => crewMemberIdSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'CrewMemberIdInput',
            create: () => crewMemberIdSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'PipelineReferencesResult',
          create: () => z.any(),
          decode: value => value as { readonly references: readonly string[] },
        },
      },
      'dshManager/ruleList': {
        service: 'dshManagerRoute',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'RouteRuleList',
          create: () => z.any(),
          decode: value => value as { readonly rules: readonly RouteRuleView[] },
        },
      },
      'dshManager/ruleAdd': {
        service: 'dshManagerRoute',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'RouteInput',
            create: () => routeInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'RouteInput',
            create: () => routeInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'RouteAddResult',
          create: () => z.any(),
          decode: value => value as { readonly rule: RouteRuleView },
        },
      },
      'dshManager/ruleUpdate': {
        service: 'dshManagerRoute',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'RouteUpdateInput',
            create: () => routeUpdateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'RouteUpdateInput',
            create: () => routeUpdateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'RouteUpdateResult',
          create: () => z.any(),
          decode: value => value as { readonly rule: RouteRuleView },
        },
      },
      'dshManager/ruleRemove': {
        service: 'dshManagerRoute',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'RouteIdInput',
            create: () => routeIdSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'RouteIdInput',
            create: () => routeIdSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'RouteRemoveResult',
          create: () => z.any(),
          decode: value => value as { readonly removed: boolean },
        },
      },
      'dshManager/ruleReferencesOfPipeline': {
        service: 'dshManagerRoute',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'PipelineIdInput',
            create: () => pipelineIdSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'PipelineIdInput',
            create: () => pipelineIdSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'RouteReferencesResult',
          create: () => z.any(),
          decode: value => value as { readonly rules: readonly string[] },
        },
      },
      'dshManager/policyList': {
        service: 'dshManagerPolicy',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'PolicyListResult',
          create: () => z.any(),
          decode: value => value as { readonly policies: readonly PolicyRecord[] },
        },
      },
      'dshManager/policyDiff': {
        service: 'dshManagerPolicy',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'PolicyDiffInput',
            create: () => policyDiffInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'PolicyDiffInput',
            create: () => policyDiffInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'PolicyDiffResult',
          create: () => z.any(),
          decode: value => value as { readonly diff: PolicyDiff },
        },
      },
      'dshManager/policyUpdate': {
        service: 'dshManagerPolicy',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawInput',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'PolicyUpdateInput',
            create: () => policyUpdateInputSchema,
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: 'PolicyUpdateInput',
            create: () => policyUpdateInputSchema,
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: 'PolicyUpdateResult',
          create: () => z.any(),
          decode: value => value as { readonly policy: PolicyRecord },
        },
      },
      'dshManager/teamConfigStatus': {
        service: 'dshManagerTeamConfig',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'TeamConfigStatus',
          create: () => z.any(),
          decode: value => value as TeamConfigStatusView,
        },
      },
      'dshManager/teamConfigReload': {
        service: 'dshManagerTeamConfig',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'TeamConfigReload',
          create: () => z.any(),
          decode: value => value as TeamConfigStatusView,
        },
      },
    },
  },
  z,
)

export default TYPERT_REMOTE
