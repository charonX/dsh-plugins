// @vitest-environment jsdom
/**
 * Slot-tier specs for team-config hot-reload sync in TeamPage:
 * 1) Polling revision bumps automatically refresh crew, pipeline, and route views.
 * 2) Validation error (`lastError`) renders an explicit alert banner and Reload clears it.
 */
import { fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'

describe('team page hot-reload sync and error banner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('automatically refreshes crew/pipelines/routes on revision bump and shows validation errors', async () => {
    vi.useFakeTimers()
    let revision = 1
    let lastError: string | undefined
    let members = [
      { id: 'c1', name: 'Initial Member', role: 'initial role', enabled: true, createdAt: 1, updatedAt: 1 },
    ]

    const runtime = await SlotTestRuntime.create()
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.ctx.slots.installLocale(locale)
    await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })

    const crewList = vi.fn().mockImplementation(async () => ({ ok: true, value: { members } }))
    const teamConfigStatus = vi.fn().mockImplementation(async () => ({
      ok: true,
      value: {
        filePath: '/tmp/team-config.yaml',
        revision,
        loadedAt: 100,
        ...(lastError === undefined ? {} : { lastError, lastErrorAt: 200 }),
      },
    }))
    const teamConfigReload = vi.fn().mockImplementation(async () => {
      lastError = undefined
      revision += 1
      return {
        ok: true,
        value: { filePath: '/tmp/team-config.yaml', revision, loadedAt: 300 },
      }
    })

    runtime.remote.provideNamespaces({
      dshManager: {
        crewList,
        modelOptions: vi.fn().mockResolvedValue({ ok: true, value: { providers: [] } }),
        agentKindOptions: vi.fn().mockResolvedValue({ ok: true, value: { kinds: [{ kind: 'builtin', command: '', available: true }] } }),
        crewAdd: vi.fn().mockResolvedValue({ ok: false }),
        crewUpdate: vi.fn().mockResolvedValue({ ok: false }),
        crewRemove: vi.fn().mockResolvedValue({ ok: true }),
        pipelineList: vi.fn().mockResolvedValue({ ok: true, value: { pipelines: [] } }),
        pipelineAdd: vi.fn().mockResolvedValue({ ok: false }),
        pipelineUpdate: vi.fn().mockResolvedValue({ ok: false }),
        pipelineRemove: vi.fn().mockResolvedValue({ ok: true }),
        pipelineReferencesOf: vi.fn().mockResolvedValue({ ok: true, value: { references: [] } }),
        ruleList: vi.fn().mockResolvedValue({ ok: true, value: { rules: [] } }),
        ruleAdd: vi.fn().mockResolvedValue({ ok: false }),
        ruleUpdate: vi.fn().mockResolvedValue({ ok: false }),
        ruleRemove: vi.fn().mockResolvedValue({ ok: true }),
        ruleReferencesOfPipeline: vi.fn().mockResolvedValue({ ok: true, value: { rules: [] } }),
        teamConfigStatus,
        teamConfigReload,
        stewardStatus: vi.fn().mockResolvedValue({ ok: true, value: { busy: false, backlog: 0, mode: 'auto', activity: [] } }),
      },
    })

    await runtime.mount({ inject: UI_INJECT, apply: registerUi })
    const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
    fireEvent.click(view.view.getByRole('tab', { name: 'Team' }))
    fireEvent.click(view.view.getByRole('tab', { name: 'Crew roster' }))

    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Initial Member')
    })

    // Simulate external YAML edit -> revision bumps and lastError appears.
    members = [
      { id: 'c1', name: 'Hot Reloaded Member', role: 'updated role', enabled: true, createdAt: 1, updatedAt: 2 },
    ]
    revision = 2
    lastError = 'pipeline "p1" stage 1 references unknown crew member "missing"'

    await vi.advanceTimersByTimeAsync(2100)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Hot Reloaded Member')
      expect(view.container.textContent).toContain('unknown crew member "missing"')
      expect(view.container.textContent).toContain('/tmp/team-config.yaml')
    })

    // Switching back to Orchestration workbench keeps the TeamConfigErrorBanner visible.
    fireEvent.click(view.view.getByRole('tab', { name: 'Orchestration workbench' }))
    expect(view.container.textContent).toContain('unknown crew member "missing"')

    // Clicking Reload clears the error banner once fixed.
    fireEvent.click(view.view.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() => {
      expect(teamConfigReload).toHaveBeenCalledTimes(1)
      expect(view.container.textContent).not.toContain('unknown crew member "missing"')
    })

    await runtime.dispose()
  })
})
