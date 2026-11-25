/** The `glab` dependency detection and per-platform install guidance seams. */
import { describe, expect, test } from 'vitest'
import { detectGlab, glabInstallCommand, type CommandProbe } from '../../src/connections/glab-dependency.ts'

describe('detectGlab', () => {
  test('an answering probe reports the installed version', () => {
    const probe: CommandProbe = () => ({ status: 0, stdout: 'glab version 1.2.3\n' })
    expect(detectGlab(probe)).toEqual({ installed: true, version: 'glab version 1.2.3' })
  })

  test('a non-zero exit reports not installed', () => {
    const probe: CommandProbe = () => ({ status: 1, stdout: '' })
    expect(detectGlab(probe)).toEqual({ installed: false })
  })

  test('a probe without stdout still reports installed', () => {
    const probe: CommandProbe = () => ({ status: 0 })
    expect(detectGlab(probe)).toEqual({ installed: true })
  })

  test('a spawn error (ENOENT) reports not installed', () => {
    const probe: CommandProbe = () => ({ status: null, error: new Error('spawn glab ENOENT') })
    expect(detectGlab(probe)).toEqual({ installed: false })
  })

  test('a failed probe reports not installed', () => {
    const probe: CommandProbe = () => undefined
    expect(detectGlab(probe)).toEqual({ installed: false })
  })
})

describe('glabInstallCommand', () => {
  test.each([
    ['darwin', 'brew install glab'],
    ['linux', 'brew install glab  # or see https://gitlab.com/gitlab-org/cli#installation for your distro'],
    ['win32', 'winget install GLab.Glab'],
  ])('%s gets a copyable command', (platform, expected) => {
    const command = glabInstallCommand(platform)
    expect(command).toBe(expected)
    expect(command).not.toMatch(/[|;&`]/) // one plain command, no shell chaining
  })
})
