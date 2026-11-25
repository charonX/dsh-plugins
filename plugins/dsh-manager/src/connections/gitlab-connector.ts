/**
 * The GitLab Connector: PAT authentication over the REST v4 API for
 * connectivity, plus the local `glab` dependency face. Outbound `glab`
 * invocations run with the connection's own instance address and token via
 * environment variables — the user's global glab login is never read or
 * mutated.
 */
import type { ConnectivityResult, ConnectorConnectivity } from './wire-types.ts'
import { detectGlab, glabInstallCommand } from './glab-dependency.ts'

/**
 * Probe one GitLab instance with a PAT: `GET /api/v4/user` answers 200 for a
 * valid credential, 401 for an invalid one, and 403 when the credential is
 * valid but lacks permission.
 * @param baseUrl - instance base URL, e.g. `https://gitlab.example.com`.
 * @param pat - the personal access token; never logged or embedded in errors.
 * @param fetchImpl - injectable fetch for tests; defaults to the global.
 * @returns the connectivity verdict.
 */
export async function testGitLabConnection(
  baseUrl: string,
  pat: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectivityResult> {
  let response: Response
  try {
    response = await fetchImpl(new URL('/api/v4/user', baseUrl).toString(), {
      headers: { 'private-token': pat, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { ok: false, reason: 'unreachable', detail }
  }
  if (response.ok) return { ok: true }
  if (response.status === 401) return { ok: false, reason: 'invalid-credentials', detail: 'the instance rejected the PAT (HTTP 401)' }
  if (response.status === 403) return { ok: false, reason: 'insufficient-permission', detail: 'the PAT is valid but lacks permission (HTTP 403)' }
  return { ok: false, reason: 'unreachable', detail: `unexpected HTTP status ${response.status}` }
}

/**
 * Environment for one `glab` invocation bound to this connection: the host
 * and token ride environment variables, so the user's global glab login
 * state is neither read nor changed.
 * @param baseUrl - the connection's instance base URL.
 * @param pat - the connection's personal access token.
 * @returns the env record layered over the ambient process env.
 */
export function glabEnvironment(baseUrl: string, pat: string): Record<string, string> {
  const host = new URL(baseUrl).host
  return { ...process.env, GITLAB_HOST: host, GITLAB_TOKEN: pat }
}

/** The GitLab Connector; Cloud deployments report a deliberate not-supported. */
export const gitlabConnector: ConnectorConnectivity = {
  async test(deployment, baseUrl, auth) {
    if (deployment === 'cloud') {
      return { ok: false, reason: 'unreachable', detail: 'GitLab.com (Cloud) connections are not supported yet' }
    }
    if (auth.kind !== 'pat') {
      return { ok: false, reason: 'invalid-credentials', detail: 'GitLab connections authenticate with a personal access token' }
    }
    return await testGitLabConnection(baseUrl, auth.pat)
  },
}

/**
 * The GitLab Connector with the local dependency face: a missing `glab`
 * short-circuits the probe with the platform install command.
 * @param dependency - injectable detector for tests; defaults to the real probe.
 * @param platform - injectable platform for tests; defaults to `process.platform`.
 * @returns the connectivity face.
 */
export function createGitLabConnector(
  dependency: () => { installed: boolean } = () => detectGlab(),
  platform: string = process.platform,
): ConnectorConnectivity & { readonly hasDependency: () => { installed: boolean } } {
  return {
    hasDependency: dependency,
    async test(deployment, baseUrl, auth) {
      if (!dependency().installed) {
        return {
          ok: false,
          reason: 'dependency-missing',
          detail: 'the glab CLI is not installed; Source features need it (connectivity testing still works)',
          installCommand: glabInstallCommand(platform),
        }
      }
      return await gitlabConnector.test(deployment, baseUrl, auth)
    },
  }
}
