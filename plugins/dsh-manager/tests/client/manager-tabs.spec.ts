// @vitest-environment jsdom
/** Unit and slot-tier specs for Manager 5-tab IA, legacy cache migration, and Board-to-Monitor shortcut. */
import { fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  MANAGER_TABS,
  TAB_STORAGE_KEY,
  loadManagerTab,
  resolveManagerTab,
  saveManagerTab,
} from '../../src/client/manager-tabs.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'
import { settingsStubs } from './settings-stubs.ts'

afterEach(() => {
  globalThis.localStorage?.clear()
})

describe('resolveManagerTab & storage helpers', () => {
  test('migrates legacy steward/records to monitor and briefings/unknown to board', () => {
    expect(MANAGER_TABS).toEqual(['board', 'team', 'policy', 'monitor', 'settings'])
    expect(resolveManagerTab('steward')).toBe('monitor')
    expect(resolveManagerTab('records')).toBe('monitor')
    expect(resolveManagerTab('briefings')).toBe('board')
    expect(resolveManagerTab('')).toBe('board')
    expect(resolveManagerTab(null)).toBe('board')
    expect(resolveManagerTab(undefined)).toBe('board')
    expect(resolveManagerTab('unknown-tab')).toBe('board')
    for (const tab of MANAGER_TABS) {
      expect(resolveManagerTab(tab)).toBe(tab)
    }
  })

  test('loadManagerTab and saveManagerTab degrade safely when storage throws', () => {
    const throwingGet = { getItem: () => { throw new Error('denied') } }
    const throwingSet = { setItem: () => { throw new Error('quota') } }
    expect(loadManagerTab(throwingGet)).toBe('board')
    expect(() => saveManagerTab('monitor', throwingSet)).not.toThrow()
  })
})

async function mountManager(extras: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('uiWorkspace', { openSession: () => {} })
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
      manualInput: vi.fn().mockResolvedValue({ ok: true, value: { threadId: 'thr-1' } }),
      notificationList: vi.fn().mockResolvedValue({ ok: true, value: { notifications: [] } }),
      attentionList: vi.fn().mockResolvedValue({ ok: true, value: { attentions: [] } }),
      answerAttention: vi.fn().mockResolvedValue({ ok: true }),
      ticketDetail: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      ticketChangeDiff: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      ...extras,
    },
  })
  await runtime.mount({ inject: [...UI_INJECT, 'uiWorkspace'], apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  return { runtime, view }
}

describe('ManagerPage 5-tab navigation', () => {
  test('renders exactly 5 top-level tabs without briefings', async () => {
    const { runtime, view } = await mountManager()
    const tabs = view.view.getAllByRole('tab').map(el => el.textContent?.trim())
    expect(tabs).toEqual(['Board', 'Team & Flows', 'Policy', 'Monitor', 'Settings'])
    expect(view.container.querySelector('#dsh-manager-tab-briefings')).toBeNull()
    expect(view.container.querySelector('#dsh-manager-tab-monitor')).not.toBeNull()
    await runtime.dispose()
  })

  test('migrates persisted steward/records localStorage tab to Monitor on mount', async () => {
    globalThis.localStorage.setItem(TAB_STORAGE_KEY, 'steward')
    const { runtime, view } = await mountManager()
    const monitorTab = view.view.getByRole('tab', { name: 'Monitor' })
    expect(monitorTab.getAttribute('aria-selected')).toBe('true')
    await runtime.dispose()

    globalThis.localStorage.setItem(TAB_STORAGE_KEY, 'records')
    const second = await mountManager()
    expect(second.view.view.getByRole('tab', { name: 'Monitor' }).getAttribute('aria-selected')).toBe('true')
    await second.runtime.dispose()
  })

  test('migrates persisted briefings localStorage tab to Board on mount', async () => {
    globalThis.localStorage.setItem(TAB_STORAGE_KEY, 'briefings')
    const { runtime, view } = await mountManager()
    expect(view.view.getByRole('tab', { name: 'Board' }).getAttribute('aria-selected')).toBe('true')
    await runtime.dispose()
  })

  test('clicking the Board Steward status chip jumps straight to Monitor', async () => {
    const { runtime, view } = await mountManager({
      stewardStatus: vi.fn().mockResolvedValue({
        ok: true,
        value: { busy: true, backlog: 3, mode: 'auto', activity: [] },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Working')
    })
    const chip = view.view.getByRole('button', { name: /Steward/i })
    fireEvent.click(chip)
    expect(view.view.getByRole('tab', { name: 'Monitor' }).getAttribute('aria-selected')).toBe('true')
    await runtime.dispose()
  })
})
