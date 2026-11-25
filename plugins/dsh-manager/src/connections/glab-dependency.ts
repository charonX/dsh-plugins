/**
 * Local `glab` dependency detection and per-platform install guidance
 * (spec user stories 8–9): detection never installs, and the guidance gives
 * one copyable command per platform without depending on any shell.
 */
import { spawnSync } from 'node:child_process'

/** Detection outcome for one probe of the local `glab` binary. */
export interface GlabDetection {
  readonly installed: boolean
  /** Reported `glab version` line when installed. */
  readonly version?: string
}

/** The runner one detection probe uses; injectable for tests. */
export type CommandProbe = (command: string, args: readonly string[]) => { status: number | null; error?: unknown; stdout?: string } | undefined

/** Default probe: one `spawnSync` without a shell, cross-platform by PATH. */
export const defaultCommandProbe: CommandProbe = (command, args) => {
  const result = spawnSync(command, [...args], { windowsHide: true, timeout: 10_000, encoding: 'utf8' })
  return { status: result.status, error: result.error, stdout: result.stdout }
}

/**
 * Probe the local `glab` binary once.
 * @param probe - injectable runner; defaults to a real `spawnSync`.
 * @returns whether glab answers `--version`, with its version line.
 */
export function detectGlab(probe: CommandProbe = defaultCommandProbe): GlabDetection {
  const result = probe('glab', ['--version'])
  if (result === undefined || result.error !== undefined || result.status !== 0) {
    return { installed: false }
  }
  const version = result.stdout?.trim()
  return version === undefined ? { installed: true } : { installed: true, version }
}

/**
 * The platform-appropriate install command for `glab`.
 * @param platform - the `process.platform` value; injectable for tests.
 * @returns the copyable install command.
 */
export function glabInstallCommand(platform: string = process.platform): string {
  if (platform === 'darwin') return 'brew install glab'
  if (platform === 'linux') return 'brew install glab  # or see https://gitlab.com/gitlab-org/cli#installation for your distro'
  return 'winget install GLab.Glab'
}
