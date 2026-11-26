// @vitest-environment jsdom
/** Slot-tier specs for the Policy page against a scripted Remote namespace. */
import { fireEvent, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PolicyRecord } from '../../src/policy/policy-core.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'
import { settingsStubs } from './settings-stubs.ts'

function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) throw new Error('the dialog is not open')
  return el
}

function policyOf(version: string, overrides: Partial<PolicyRecord> = {}): PolicyRecord {
  return {
    version,
    approvalCategories: ['comment', 'push-branch'],
    decisions: [],
    createdAt: 1000,
    ...overrides,
  }
}

async function mountPolicy(overrides: {
  policyList?: ReturnType<typeof vi.fn>
  policyUpdate?: ReturnType<typeof vi.fn>
} = {}): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
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
      manualInput: vi.fn().mockResolvedValue({ ok: true, value: { threadId: 'thr' } }),
      projectList: vi.fn().mockResolvedValue({ ok: true, value: { projects: [] } }),
      notificationList: vi.fn().mockResolvedValue({ ok: true, value: { notifications: [] } }),
      attentionList: vi.fn().mockResolvedValue({ ok: true, value: { attentions: [] } }),
      answerAttention: vi.fn().mockResolvedValue({ ok: true }),
      ticketDetail: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      ticketChangeDiff: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      policyList: overrides.policyList ?? vi.fn().mockResolvedValue({ ok: true, value: { policies: [policyOf('1')] } }),
      policyUpdate: overrides.policyUpdate ?? vi.fn().mockResolvedValue({ ok: false }),
    },
  })
  await runtime.mount({ inject: [...UI_INJECT, 'uiWorkspace'], apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  fireEvent.click(view.view.getByRole('tab', { name: 'Policy' }))
  return { runtime, view }
}

describe('policy page', () => {
  test('renders active version, decision records, and approval gates', async () => {
    const { runtime, view } = await mountPolicy({
      policyList: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          policies: [
            policyOf('2', {
              decisions: [
                { id: 'd1', kind: 'preference', statement: 'Prefer vertical slice TDD', createdAt: 2000 },
                { id: 'd2', kind: 'rejection', statement: 'Never push without tests', createdAt: 2001 },
              ],
            }),
            policyOf('1'),
          ],
        },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Active v2')
    })
    expect(view.container.textContent).toContain('Prefer vertical slice TDD')
    expect(view.container.textContent).toContain('Never push without tests')
    expect(view.container.textContent).toContain('Approval gates')
    await runtime.dispose()
  })

  test('submitting a new decision rule calls policyUpdate and closes the modal', async () => {
    const policyUpdate = vi.fn().mockResolvedValue({
      ok: true,
      value: { policy: policyOf('2', { decisions: [{ id: 'd1', kind: 'preference', statement: 'Always run typecheck', createdAt: 2000 }] }) },
    })
    const { runtime, view } = await mountPolicy({ policyUpdate })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Active v1')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add policy rule' }))
    const dialog = dialogEl()
    fireEvent.change(within(dialog).getByPlaceholderText(/standing preference/i), {
      target: { value: 'Always run typecheck' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save as new version' }))
    await vi.waitFor(() => {
      expect(policyUpdate).toHaveBeenCalledWith({
        addEntries: [{ kind: 'preference', statement: 'Always run typecheck' }],
      })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    await runtime.dispose()
  })
})
