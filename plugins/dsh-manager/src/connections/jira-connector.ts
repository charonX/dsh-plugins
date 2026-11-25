/**
 * The Jira Connector's connectivity face: Server/DC with PAT or Basic, Cloud
 * with email + API token (Basic). The test resolves one REST endpoint of the
 * instance and maps HTTP/network outcomes onto the user-facing reasons.
 */
import type { ConnectionAuth, ConnectivityResult } from './wire-types.ts'

/** Deployment family of a Jira connection. */
export type JiraDeployment = 'server-dc' | 'cloud'

export type { ConnectivityResult, ConnectorConnectivity } from './wire-types.ts'
import type { ConnectorConnectivity } from './wire-types.ts'

/** Encode one Basic credential header value. */
function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

/** The Authorization header one credential face sends. */
function authorizationOf(auth: ConnectionAuth): string {
  return auth.kind === 'pat' ? `Bearer ${auth.pat}` : basicHeader(auth.username, auth.password)
}

/**
 * Probe one Jira instance with a PAT: `GET /rest/api/2/myself` answers 200
 * for a valid credential, 401 for an invalid one, and 403 when the credential
 * is valid but lacks permission.
 * @param baseUrl - instance base URL, e.g. `https://jira.example.com`.
 * @param auth - the credential face; never logged or embedded in errors.
 * @param fetchImpl - injectable fetch for tests; defaults to the global.
 * @returns the connectivity verdict.
 */
export async function testJiraConnection(
  baseUrl: string,
  auth: ConnectionAuth,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectivityResult> {
  let response: Response
  try {
    response = await fetchImpl(new URL('/rest/api/2/myself', baseUrl).toString(), {
      headers: { authorization: authorizationOf(auth), accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { ok: false, reason: 'unreachable', detail }
  }
  if (response.ok) return { ok: true }
  if (response.status === 401) return { ok: false, reason: 'invalid-credentials', detail: 'the instance rejected the credential (HTTP 401)' }
  if (response.status === 403) return { ok: false, reason: 'insufficient-permission', detail: 'the credential is valid but lacks permission (HTTP 403)' }
  return { ok: false, reason: 'unreachable', detail: `unexpected HTTP status ${response.status}` }
}

/** The Jira Connector: Server/DC with PAT or Basic, Cloud with email + API token. */
export const jiraConnector: ConnectorConnectivity = {
  async test(deployment, baseUrl, auth) {
    if (deployment === 'cloud' && auth.kind === 'pat') {
      return { ok: false, reason: 'unreachable', detail: 'Jira Cloud connections authenticate with email + API token (Basic), not a PAT' }
    }
    return await testJiraConnection(baseUrl, auth)
  },
}
