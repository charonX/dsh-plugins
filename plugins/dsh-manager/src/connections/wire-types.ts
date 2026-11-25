/**
 * Wire-level types and input schemas of the connections API — shared by the
 * Host service and the client contribution, so the browser face never pulls
 * in Node-only connector modules.
 */
import { z as zod } from 'zod'

export type { ConnectorKind } from './connections-domain.ts'
import type { ConnectorKind } from './connections-domain.ts'

/** One connection as the wire sees it — never carries the credential. */
export interface ConnectionView {
  readonly id: string
  readonly connector: ConnectorKind
  readonly name: string
  readonly deployment: 'server-dc' | 'cloud'
  readonly baseUrl: string
  readonly authMethod: AuthMethod
  /** Non-secret identity for Basic auth: username (Server/DC) or email (Cloud). */
  readonly authIdentity?: string
  /** Whether the connection is active; disabled ones stop their Source instances. */
  readonly enabled: boolean
  readonly status: 'unconfigured' | 'dependency-missing' | 'invalid-credentials' | 'ok'
  readonly testedAt?: number
  /** Copyable install command when the status is `dependency-missing`. */
  readonly installCommand?: string
}

/** Input of adding a connection; the secret goes to the credentials store. */
export interface ConnectionAddInput {
  readonly connector: ConnectorKind
  readonly name: string
  readonly deployment: 'server-dc' | 'cloud'
  readonly baseUrl: string
  readonly authMethod: AuthMethod
  /** Required for Basic auth: the username (Server/DC) or email (Cloud). */
  readonly authIdentity?: string
  /** The PAT value, or the password / API token for Basic auth. */
  readonly secret: string
}

/** Input of editing one connection; every field but the id is optional. */
export interface ConnectionUpdateInput {
  readonly id: string
  readonly name?: string
  readonly deployment?: 'server-dc' | 'cloud'
  readonly baseUrl?: string
  readonly authMethod?: AuthMethod
  readonly authIdentity?: string
  /** When present, the credential is rotated in the same edit. */
  readonly secret?: string
  readonly enabled?: boolean
}

/** Input of rotating one connection's credential. */
export interface ConnectionCredentialInput {
  readonly id: string
  /** The PAT value, or the password / API token for Basic auth. */
  readonly secret: string
}

const baseUrlSchema = zod.string().refine(value => {
  try { new URL(value); return true } catch { return false }
}, 'baseUrl must be an absolute URL')

export const connectionAddInputSchema = zod.object({
  connector: zod.enum(['jira', 'gitlab']),
  name: zod.string().min(1),
  deployment: zod.enum(['server-dc', 'cloud']),
  baseUrl: baseUrlSchema,
  authMethod: zod.enum(['pat', 'basic']),
  authIdentity: zod.string().min(1).optional(),
  secret: zod.string().min(1),
}).refine(
  input => input.authMethod === 'pat' || input.authIdentity !== undefined,
  'Basic auth needs an identity (username or email)',
)

export const connectionUpdateInputSchema = zod.object({
  id: zod.string().min(1),
  name: zod.string().min(1).optional(),
  deployment: zod.enum(['server-dc', 'cloud']).optional(),
  baseUrl: baseUrlSchema.optional(),
  authMethod: zod.enum(['pat', 'basic']).optional(),
  authIdentity: zod.string().min(1).optional(),
  secret: zod.string().min(1).optional(),
  enabled: zod.boolean().optional(),
})

export const connectionCredentialInputSchema = zod.object({
  id: zod.string().min(1),
  secret: zod.string().min(1),
})

/** Authentication methods the connections page offers. */
export type AuthMethod = 'pat' | 'basic'

/**
 * The resolved credential face a Connector test authenticates with. The
 * secret never crosses back to the wire; this face is host-internal.
 */
export type ConnectionAuth =
  | { readonly kind: 'pat'; readonly pat: string }
  | { readonly kind: 'basic'; readonly username: string; readonly password: string }

/** Connectivity verdict shown verbatim on the connection card. */
export type ConnectivityResult =
  | { readonly ok: true }
  | {
    readonly ok: false
    /** 依赖缺失 / 地址不通 / 凭据无效 / 权限不足. */
    readonly reason: 'dependency-missing' | 'unreachable' | 'invalid-credentials' | 'insufficient-permission'
    /** Human-readable detail for diagnosis; never carries the PAT. */
    readonly detail: string
    /** Copyable install command when the reason is `dependency-missing`. */
    readonly installCommand?: string
  }

/** Connectivity face one Connector implementation provides. */
export interface ConnectorConnectivity {
  /**
   * Test one connection's deployment against its credential.
   * @param deployment - stored deployment kind.
   * @param baseUrl - stored instance base URL.
   * @param auth - resolved credential face.
   * @returns the connectivity verdict.
   */
  test(deployment: 'server-dc' | 'cloud', baseUrl: string, auth: ConnectionAuth): Promise<ConnectivityResult>
}
