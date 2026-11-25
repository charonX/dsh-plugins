/**
 * Host service behind the connections config page: persisted Connection
 * records over storage-domain, secrets in the harness credentials store
 * under the connection id, and connectivity tests through the Connector.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  CREDENTIAL_OWNER, connectionsDomain,
  credentialIdOf,
  type ConnectionId, type ConnectionRecord, type ConnectionStatus,
  type ConnectorKind, type DeploymentKind,
} from './connections/connections-domain.ts'
import { jiraConnector } from './connections/jira-connector.ts'
import { glabInstallCommand } from './connections/glab-dependency.ts'
import type { ConnectivityResult } from './connections/wire-types.ts'
import { createGitLabConnector } from './connections/gitlab-connector.ts'
import { connectionAddInputSchema, connectionCredentialInputSchema, connectionUpdateInputSchema, type AuthMethod, type ConnectionAddInput, type ConnectionAuth, type ConnectionCredentialInput, type ConnectionUpdateInput, type ConnectionView } from './connections/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Connections config-page API served to the Dsh Manager client. */
    dshManagerConnections: DshManagerConnections
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed connection does not exist. */
    'dshManager/connection-not-found': { readonly id: string }
    /** The connection edit would leave the record inconsistent. */
    'dshManager/connection-invalid': { readonly id: string }
  }
}

/** Connections facet configuration. */
export interface ConnectionsConfig {}

export const ConnectionsConfig: z<ConnectionsConfig> = z.object({})

/** One connection as the wire sees it — never carries the credential. */
export type { ConnectionView }
/** Input of adding a connection; the secret goes to the credentials store. */
export type { ConnectionAddInput }
/** Input of editing one connection; every field but the id is optional. */
export type { ConnectionUpdateInput }
/** Input of rotating one connection's credential. */
export type { ConnectionCredentialInput }

function viewOf(record: ConnectionRecord): ConnectionView {
  return {
    id: record.id,
    connector: record.connector,
    name: record.name,
    deployment: record.deployment,
    baseUrl: record.baseUrl,
    authMethod: record.authMethod,
    ...(record.authIdentity === undefined ? {} : { authIdentity: record.authIdentity }),
    enabled: record.enabled,
    status: record.status,
    ...(record.testedAt === undefined ? {} : { testedAt: record.testedAt }),
    ...(record.connector === 'gitlab' && record.status === 'dependency-missing'
      ? { installCommand: glabInstallCommand(process.platform) }
      : {}),
  }
}

/** Credential-side outcomes refresh the stored status; address failures leave it. */
function statusOf(result: ConnectivityResult, previous: ConnectionStatus): ConnectionStatus {
  if (result.ok) return 'ok'
  if (result.reason === 'unreachable') return previous
  if (result.reason === 'dependency-missing') return 'dependency-missing'
  return 'invalid-credentials'
}

/** The connectivity face one Connector provides. */
type Connectivity = (typeof jiraConnector)

/** The Connector registry: one connectivity face per shipped kind. */
const CONNECTORS: Record<ConnectorKind, Connectivity> = {
  jira: jiraConnector,
  gitlab: createGitLabConnector(),
}

/** Config-page API: add, test, rotate, and remove connections. */
export class DshManagerConnections extends TypertRemoteService {
  /** Host services the connections API reads. */
  static inject = ['storageDomain', 'credentials']

  static Config: z<ConnectionsConfig> = ConnectionsConfig

  private domain?: Domain<typeof connectionsDomain>

  constructor(ctx: Context, config: ConnectionsConfig) {
    super(ctx, 'dshManagerConnections', { namespace: 'dshManager' })
    void config
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(connectionsDomain)
    this.domain = domain
    this.ctx.effect(() => async () => { await domain.close() }, 'dsh-manager: close connections domain')
  }

  /** List every connection; the credential never appears. */
  @Remote
  async connectionList(): Promise<{ readonly connections: readonly ConnectionView[] }> {
    const connections = [...this.domain!.table('connections').entries()]
      .map(([, record]) => viewOf(record))
    return { connections }
  }

  /** Add one connection, store its secret, run the first connectivity test, and report the view. */
  @Remote
  async connectionAdd(rawInput: ConnectionAddInput): Promise<ConnectionView> {
    const input = connectionAddInputSchema.parse(rawInput)
    const id = crypto.randomUUID()
    const record: ConnectionRecord = {
      id,
      connector: input.connector,
      name: input.name,
      deployment: input.deployment,
      baseUrl: input.baseUrl,
      authMethod: input.authMethod,
      ...(input.authIdentity === undefined ? {} : { authIdentity: input.authIdentity }),
      enabled: true,
      status: 'unconfigured',
    }
    await this.domain!.table('connections').put(id as ConnectionId, record)
    await this.storeCredential(id, input.authMethod, input.authIdentity, input.secret)
    return (await this.probe(id)).view
  }

  /** Edit one connection's facts, credential, or enabled flag; the next use picks everything up. */
  @Remote
  async connectionUpdate(rawInput: ConnectionUpdateInput): Promise<ConnectionView> {
    const input = connectionUpdateInputSchema.parse(rawInput)
    const record = await this.requireRecord(input.id)
    const authMethod = input.authMethod ?? record.authMethod
    const authIdentity = authMethod === 'basic'
      ? input.authIdentity ?? record.authIdentity
      : input.authIdentity
    if (authMethod === 'basic' && authIdentity === undefined) {
      throw new RemoteError('dshManager/connection-invalid', 'basic auth needs an identity (username or email)', { id: input.id })
    }
    const updated: ConnectionRecord = {
      ...record,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      authMethod,
      ...(authIdentity === undefined ? {} : { authIdentity }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    }
    await this.domain!.table('connections').put(updated.id as ConnectionId, updated)
    if (input.secret !== undefined) {
      await this.storeCredential(input.id, authMethod, authIdentity, input.secret)
    }
    return (await this.probe(input.id)).view
  }

  /** Test one connection now and report the verdict; durable health refreshes. */
  @Remote
  async connectionTest(id: string): Promise<ConnectivityResult> {
    return (await this.probe(id)).result
  }

  /** Rotate one connection's secret without restarting or editing configuration. */
  @Remote
  async connectionUpdateCredential(rawInput: ConnectionCredentialInput): Promise<ConnectionView> {
    const input = connectionCredentialInputSchema.parse(rawInput)
    const record = await this.requireRecord(input.id)
    await this.storeCredential(input.id, record.authMethod, record.authIdentity, input.secret)
    return (await this.probe(input.id)).view
  }

  /** How many Source instances and mappings a removal would affect; the client prompts when nonzero. */
  @Remote
  async connectionDeleteInfo(id: string): Promise<{ sources: number; mappings: number }> {
    await this.requireRecord(id)
    // Source instances and mappings arrive with tickets 06/07; until then a
    // removal never orphans anything, so the preview stays all zeros.
    return { sources: 0, mappings: 0 }
  }

  /** Remove one connection and its stored credential. */
  @Remote
  async connectionRemove(id: string): Promise<void> {
    await this.requireRecord(id)
    await this.ctx.credentials.deleteRecord(this.credentialKey(id))
    await this.domain!.table('connections').delete(id as ConnectionId)
  }

  /** Persist one secret under the connection's credential record, shaped by the auth method. */
  private async storeCredential(
    id: string,
    authMethod: AuthMethod,
    authIdentity: string | undefined,
    secret: string,
  ): Promise<void> {
    await this.ctx.credentials.modifyRecord(this.credentialKey(id), async () => authMethod === 'basic'
      ? { kind: 'api-key', env: { username: authIdentity ?? '', password: secret } }
      : { kind: 'api-key', key: secret })
  }

  private credentialKey(id: string) {
    return credentialKey(CREDENTIAL_OWNER, credentialIdOf(id as ConnectionId))
  }

  /** Resolve the stored credential; absent means unconfigured, never an error. */
  private async resolveAuth(id: string, authMethod: AuthMethod): Promise<ConnectionAuth | undefined> {
    const record = await this.ctx.credentials.readRecord(this.credentialKey(id))
    if (authMethod === 'pat') {
      return record?.kind === 'api-key' && record.key !== undefined && record.key !== ''
        ? { kind: 'pat', pat: record.key }
        : undefined
    }
    const username = record?.kind === 'api-key' ? record.env?.['username'] : undefined
    const password = record?.kind === 'api-key' ? record.env?.['password'] : undefined
    return username !== undefined && username !== '' && password !== undefined && password !== ''
      ? { kind: 'basic', username, password }
      : undefined
  }

  private async requireRecord(id: string): Promise<ConnectionRecord> {
    const record = this.domain!.table('connections').get(id as ConnectionId)
    if (record === undefined) {
      throw new RemoteError('dshManager/connection-not-found', `connection ${id} does not exist`, { id })
    }
    return record
  }

  /** Resolve one connection's display name synchronously for board/detail views. */
  connectionName(id: string): string | undefined {
    return this.domain?.table('connections').get(id as ConnectionId)?.name
  }

  /** Resolve one connection's poll face for host-internal use; absent means no record. */
  async resolveConnectionFacts(id: string): Promise<{ baseUrl: string; auth: ConnectionAuth } | undefined> {
    const record = this.domain!.table('connections').get(id as ConnectionId)
    if (record === undefined) return undefined
    const auth = await this.resolveAuth(id, record.authMethod)
    if (auth === undefined) return undefined
    return { baseUrl: record.baseUrl, auth }
  }

  /** Run the connectivity test through the Connector, persist the outcome, and return both views. */
  private async probe(id: string): Promise<{ readonly view: ConnectionView; readonly result: ConnectivityResult }> {
    const record = await this.requireRecord(id)
    const connector = CONNECTORS[record.connector]
    if (connector === undefined) {
      throw new RemoteError('dshManager/connection-not-found', `no connector for kind ${record.connector}`, { id })
    }
    const auth = await this.resolveAuth(id, record.authMethod)
    const result = auth === undefined
      ? { ok: false as const, reason: 'invalid-credentials' as const, detail: 'no credential stored for this connection' }
      : await connector.test(record.deployment, record.baseUrl, auth)
    const status = statusOf(result, record.status)
    const updated: ConnectionRecord = { ...record, status, testedAt: Date.now() }
    await this.domain!.table('connections').put(id as ConnectionId, updated)
    return { view: viewOf(updated), result }
  }
}

export default DshManagerConnections
