// @vitest-environment jsdom
/** Slot-tier specs for the settings page's general section against a scripted Remote namespace. */
import { fireEvent } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'
import { settingsStubs } from './settings-stubs.ts'

/** Mount the settings UI against a runtime whose Remote reads are scripted. */
async function mountSettings(uiSettings: ReturnType<typeof vi.fn>, uiSettingsUpdate: ReturnType<typeof vi.fn>): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      ...settingsStubs(),
      summary: vi.fn().mockResolvedValue({ ok: true, value: { columns: [] } }),
      ticketList: vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      candidateList: vi.fn().mockResolvedValue({ ok: true, value: { candidates: [] } }),
      evalList: vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } }),
      evalRequeue: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      acceptCandidate: vi.fn().mockResolvedValue({ ok: true }),
      manualInput: vi.fn().mockResolvedValue({ ok: true, value: { threadId: 'thr' } }),
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
      projectList: vi.fn().mockResolvedValue({ ok: true, value: { projects: [] } }),
      notificationList: vi.fn().mockResolvedValue({ ok: true, value: { notifications: [] } }),
      attentionList: vi.fn().mockResolvedValue({ ok: true, value: { attentions: [] } }),
      answerAttention: vi.fn().mockResolvedValue({ ok: true }),
      ticketDetail: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      ticketChangeDiff: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      uiSettings,
      uiSettingsUpdate,
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  // The single tabbed panel defaults to the board; open the settings tab.
  fireEvent.click(view.view.getByRole('tab', { name: 'Settings' }))
  return { runtime, view }
}

describe('settings general section', () => {
  test('the stored custom name is the input placeholder; the default shows the hint', async () => {
    const { runtime, view } = await mountSettings(
      vi.fn().mockResolvedValue({ ok: true, value: { settings: { title: '作战室' } } }),
      vi.fn().mockResolvedValue({ ok: true, value: { settings: { title: '作战室' } } }),
    )
    await vi.waitFor(() => {
      const input = view.view.getByPlaceholderText('作战室') as HTMLInputElement
      expect(input.value).toBe('')
    })
    await runtime.dispose()
  })

  test('saving a name calls uiSettingsUpdate and confirms; an empty save clears', async () => {
    const uiSettingsUpdate = vi.fn().mockResolvedValue({ ok: true, value: { settings: { title: '作战室' } } })
    const { runtime, view } = await mountSettings(
      vi.fn().mockResolvedValue({ ok: true, value: { settings: {} } }),
      uiSettingsUpdate,
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('General')
    })
    const input = view.view.getByPlaceholderText('Defaults to “Control Center”')
    fireEvent.change(input, { target: { value: '作战室' } })
    fireEvent.click(view.view.getByRole('button', { name: 'Save name' }))
    await vi.waitFor(() => {
      expect(uiSettingsUpdate).toHaveBeenCalledWith({ title: '作战室' })
      expect(view.container.textContent).toContain('Saved')
    })
    // Clearing the field saves an empty title: the custom name drops.
    fireEvent.change(view.view.getByPlaceholderText('作战室'), { target: { value: '' } })
    fireEvent.click(view.view.getByRole('button', { name: 'Save name' }))
    await vi.waitFor(() => {
      expect(uiSettingsUpdate).toHaveBeenLastCalledWith({ title: '' })
    })
    await runtime.dispose()
  })

  test('a rejecting save shows the failure copy and keeps the draft', async () => {
    const { runtime, view } = await mountSettings(
      vi.fn().mockResolvedValue({ ok: true, value: { settings: {} } }),
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('General')
    })
    fireEvent.change(view.view.getByPlaceholderText('Defaults to “Control Center”'), { target: { value: '作战室' } })
    fireEvent.click(view.view.getByRole('button', { name: 'Save name' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Saving failed')
    })
    expect((view.view.getByPlaceholderText('Defaults to “Control Center”') as HTMLInputElement).value).toBe('作战室')
    await runtime.dispose()
  })

  test('saving Steward batch triage limit calls uiSettingsUpdate with parsed integer and confirms', async () => {
    const uiSettingsUpdate = vi.fn().mockResolvedValue({ ok: true, value: { settings: { evalBatchSize: 15 } } })
    const { runtime, view } = await mountSettings(
      vi.fn().mockResolvedValue({ ok: true, value: { settings: {} } }),
      uiSettingsUpdate,
    )
    const input = await vi.waitFor(() =>
      view.view.getByLabelText('Steward batch triage limit (items/batch)') as HTMLInputElement,
    )
    expect(input.value).toBe('10')
    fireEvent.change(input, { target: { value: '15' } })
    fireEvent.click(view.view.getByRole('button', { name: 'Save limit' }))
    await vi.waitFor(() => {
      expect(uiSettingsUpdate).toHaveBeenCalledWith({ evalBatchSize: 15 })
      expect(view.container.textContent).toContain('Saved batch triage limit.')
    })
    await runtime.dispose()
  })
})
