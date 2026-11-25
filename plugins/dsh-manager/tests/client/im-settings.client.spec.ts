// @vitest-environment jsdom
/** Slot-tier specs for the Settings page IM companion section. */
import { fireEvent } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'
import { settingsStubs } from './settings-stubs.ts'

async function mountImSettings(
  imSettings: ReturnType<typeof vi.fn>,
  imSettingsUpdate: ReturnType<typeof vi.fn>,
  imTestSend: ReturnType<typeof vi.fn>,
): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
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
      evalRequeue: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      acceptCandidate: vi.fn().mockResolvedValue({ ok: true }),
      manualInput: vi.fn().mockResolvedValue({ ok: true, value: { threadId: 'thr' } }),
      notificationList: vi.fn().mockResolvedValue({ ok: true, value: { notifications: [] } }),
      attentionList: vi.fn().mockResolvedValue({ ok: true, value: { attentions: [] } }),
      answerAttention: vi.fn().mockResolvedValue({ ok: true }),
      ticketDetail: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      ticketChangeDiff: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      imSettings,
      imSettingsUpdate,
      imTestSend,
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  fireEvent.click(view.view.getByRole('tab', { name: 'Settings' }))
  return { runtime, view }
}

describe('settings IM bridge section', () => {
  test('lists discovered dsh-im bots/targets, defaults to attention scope, and saves + tests', async () => {
    const snapshot = {
      available: true,
      settings: { enabled: false, notifyAttention: true, notifyProgress: false },
      bots: [{
        botId: 'bot_wx_1',
        channel: 'weixin',
        targets: [{ targetId: 'owner', name: 'My WeChat', kind: 'user' }],
      }],
    }
    const imSettings = vi.fn().mockResolvedValue({ ok: true, value: snapshot })
    const imSettingsUpdate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        settings: { ...snapshot.settings, enabled: true, botId: 'bot_wx_1', targetId: 'owner' },
      },
    })
    const imTestSend = vi.fn().mockResolvedValue({ ok: true, value: { sent: true } })

    const { runtime, view } = await mountImSettings(imSettings, imSettingsUpdate, imTestSend)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('weixin (bot_wx_1)')
    })

    const attentionCheck = view.view.getByLabelText('Approvals and human attentions (Recommended)') as HTMLInputElement
    const progressCheck = view.view.getByLabelText('Stage progress and Web console action sync') as HTMLInputElement
    const enableCheck = view.view.getByLabelText('Enable IM notification delivery') as HTMLInputElement
    expect(attentionCheck.checked).toBe(true)
    expect(progressCheck.checked).toBe(false)
    expect(view.view.queryByLabelText(/briefing/i)).toBeNull()

    fireEvent.click(enableCheck)
    fireEvent.click(view.view.getByRole('button', { name: 'Save IM settings' }))
    await vi.waitFor(() => {
      expect(imSettingsUpdate).toHaveBeenCalledWith({
        enabled: true,
        botId: 'bot_wx_1',
        targetId: 'owner',
        notifyAttention: true,
        notifyProgress: false,
      })
      expect(view.container.textContent).toContain('IM settings saved.')
    })

    fireEvent.click(view.view.getByRole('button', { name: 'Send test' }))
    await vi.waitFor(() => {
      expect(imTestSend).toHaveBeenCalledWith({ botId: 'bot_wx_1', targetId: 'owner' })
      expect(view.container.textContent).toContain('Test message sent.')
    })
    await runtime.dispose()
  })
})
