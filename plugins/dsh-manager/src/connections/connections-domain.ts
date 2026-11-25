import { z } from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable connection identity within one Connector. */
export type ConnectionId = Branded<'ConnectionId'>

/** Connector kinds this bundle ships; growable enum. */
export const CONNECTOR_KINDS = ['jira', 'gitlab'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/** Deployment kinds; Cloud support is reserved for a later slice. */
export const DEPLOYMENT_KINDS = ['server-dc', 'cloud'] as const
export type DeploymentKind = (typeof DEPLOYMENT_KINDS)[number]

/** Authentication methods; PAT and Basic (username + password) ship. */
export const AUTH_METHODS = ['pat', 'basic'] as const
export type AuthMethod = (typeof AUTH_METHODS)[number]

/** Last known connection health, refreshed by connectivity tests. */
export const CONNECTION_STATUSES = ['unconfigured', 'dependency-missing', 'invalid-credentials', 'ok'] as const
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]

/** One persisted user connection onto one Connector. */
export const connectionRecord = z.object({
  /** Stable connection id (also the credential record id). */
  id: z.string(),
  /** Which Connector this connection instantiates. */
  connector: z.enum(CONNECTOR_KINDS),
  /** User-facing label. */
  name: z.string(),
  /** Deployment family; `cloud` is stored but its connector support is reserved. */
  deployment: z.enum(DEPLOYMENT_KINDS),
  /** Instance base URL. */
  baseUrl: z.string(),
  /** Authentication method; the credential itself lives in the credentials store. */
  authMethod: z.enum(AUTH_METHODS),
  /** Non-secret identity for Basic auth: the username (Server/DC) or email (Cloud). */
  authIdentity: z.string().optional(),
  /** Whether the connection is active; disabled ones stop their Source instances. */
  enabled: z.boolean().default(true),
  /** Last known health from the most recent connectivity test. */
  status: z.enum(CONNECTION_STATUSES),
  /** Epoch millis of the last connectivity test; absent while never tested. */
  testedAt: z.number().optional(),
})

export type ConnectionRecord = z.infer<typeof connectionRecord>

/**
 * Durable user connections. Secrets never land here: the record carries the
 * connection facts, the credentials store carries the PAT under the
 * connection id (ADR-free framework decision from spec 0001 implementation
 * decision 4).
 */
export const connectionsDomain = defineDomain({
  name: 'dsh_manager_connections',
  version: 1,
  tables: {
    connections: domainTable<ConnectionId, ConnectionRecord>(connectionRecord),
  },
})

/** Credential record scope of this bundle in the harness credentials store. */
export const CREDENTIAL_OWNER = 'dsh-manager'

/**
 * The credential record id one connection's secret lives under. The
 * credentials seam requires POSIX-ish lowercase segments, so the id prefixes
 * the connection id with a letter anchor.
 */
export function credentialIdOf(connectionId: ConnectionId): string {
  return `conn-${connectionId}`
}
