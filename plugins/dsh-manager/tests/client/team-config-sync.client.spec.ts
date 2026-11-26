// @vitest-environment jsdom
/**
 * Slot-tier specs for team-config hot-reload sync in TeamPage:
 * 1) Polling revision bumps automatically refresh flows and skills views.
 * 2) Validation error (`lastError`) renders an explicit alert banner and Reload clears it.
 */
import { fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { FlowDef } from '../../src/flow/flow-ir.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'

describe('team page hot-reload sync and error banner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('automatically refreshes flows on revision bump and shows validation errors', async () => {
    vi.useFakeTimers()
    let revision = 1
    let lastError: string | undefined
    let flows: FlowDef[] = [
      {
        id: 'f1',
        name: 'Initial Flow',
        when: 'initial condition',
        workspaceMode: 'in-place',
        enabled: true,
        steps: [{ id: 's1', name: 'Draft', skills: ['how'] }],
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    const runtime = await SlotTestRuntime.create()
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('uiWorkspace', { openSession: () => {} })
    runtime.ctx.slots.installLocale(locale)
    await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })

    const flowList = vi.fn().mockImplementation(async () => ({ ok: true, value: { flows } }))
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
        flowList,
        skillCatalog: vi.fn().mockResolvedValue({ ok: true, value: { skills: [] } }),
        modelOptions: vi.fn().mockResolvedValue({ ok: true, value: { providers: [] } }),
        agentKindOptions: vi.fn().mockResolvedValue({ ok: true, value: { kinds: [{ kind: 'builtin', command: '', available: true }] } }),
        flowAdd: vi.fn().mockResolvedValue({ ok: false }),
        flowUpdate: vi.fn().mockResolvedValue({ ok: false }),
        flowRemove: vi.fn().mockResolvedValue({ ok: true }),
        flowPresetApply: vi.fn().mockResolvedValue({ ok: false }),
        flowImportPlaybook: vi.fn().mockResolvedValue({ ok: false }),
        flowSyncPlaybook: vi.fn().mockResolvedValue({ ok: false }),
        teamConfigExportYaml: vi.fn().mockResolvedValue({ ok: true, value: { yaml: 'version: 3\nflows: []\n' } }),
        teamConfigImportYaml: vi.fn().mockResolvedValue({ ok: false }),
        teamConfigStatus,
        teamConfigReload,
        stewardStatus: vi.fn().mockResolvedValue({ ok: true, value: { busy: false, backlog: 0, mode: 'auto', activity: [] } }),
      },
    })

    await runtime.mount({ inject: [...UI_INJECT, 'uiWorkspace'], apply: registerUi })
    const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
    fireEvent.click(view.view.getByRole('tab', { name: 'Team & Flows' }))

    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Initial Flow')
    })
    fireEvent.click(view.view.getByRole('tab', { name: 'List' }))

    // Simulate external YAML edit -> revision bumps and lastError appears.
    flows = [
      {
        id: 'f1',
        name: 'Hot Reloaded Flow',
        when: 'updated condition',
        workspaceMode: 'in-place',
        enabled: true,
        steps: [{ id: 's1', name: 'Publish', skills: ['verify'] }],
        createdAt: 1,
        updatedAt: 2,
      },
    ]
    revision = 2
    lastError = 'flow "f1" step "s1" references unknown onFail step "missing"'

    await vi.advanceTimersByTimeAsync(2100)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Hot Reloaded Flow')
      expect(view.container.textContent).toContain('unknown onFail step "missing"')
      expect(view.container.textContent).toContain('/tmp/team-config.yaml')
    })

    // Switching to Skills and back keeps the TeamConfigErrorBanner visible.
    fireEvent.click(view.view.getByRole('tab', { name: 'Skills' }))
    expect(view.container.textContent).toContain('unknown onFail step "missing"')
    fireEvent.click(view.view.getByRole('tab', { name: 'Flows' }))

    // Clicking Reload clears the error banner once fixed.
    fireEvent.click(view.view.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() => {
      expect(teamConfigReload).toHaveBeenCalledTimes(1)
      expect(view.container.textContent).not.toContain('unknown onFail step "missing"')
    })

    await runtime.dispose()
  })
})
