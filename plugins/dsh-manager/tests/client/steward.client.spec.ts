// @vitest-environment jsdom
/** Slot-tier specs for the steward status page against a scripted Remote namespace. */
import { fireEvent } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { StewardStatusView } from '../../src/evals/wire-types.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'

/** A steward status with sensible defaults. */
function statusOf(overrides: Partial<StewardStatusView> = {}): StewardStatusView {
  return {
    busy: false,
    backlog: 0,
    mode: 'auto',
    activity: [],
    ...overrides,
  }
}

/** Mount the team page against a runtime whose remote answers are scripted. */
async function mountSteward(stewardStatus: ReturnType<typeof vi.fn>): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      stewardStatus,
      // The team page reads flows and skills alongside the status; keep both quiet.
      flowList: vi.fn().mockResolvedValue({ ok: true, value: { flows: [] } }),
      flowAdd: vi.fn().mockResolvedValue({ ok: false }),
      flowUpdate: vi.fn().mockResolvedValue({ ok: false }),
      flowRemove: vi.fn().mockResolvedValue({ ok: true }),
      flowPresetApply: vi.fn().mockResolvedValue({ ok: false }),
      flowImportPlaybook: vi.fn().mockResolvedValue({ ok: false }),
      flowSyncPlaybook: vi.fn().mockResolvedValue({ ok: false }),
      skillCatalog: vi.fn().mockResolvedValue({ ok: true, value: { skills: [] } }),
      // The run records section on the team page stays quiet.
      evalList: vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } }),
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  // The single tabbed panel defaults to the board; open the Monitor tab and switch to Steward activity.
  fireEvent.click(view.view.getByRole('tab', { name: 'Monitor' }))
  fireEvent.click(view.view.getByRole('tab', { name: 'Steward activity' }))
  return { runtime, view }
}

describe('steward status page', () => {
  test('an idle steward shows the idle dot, its mode, and an empty backlog', async () => {
    const { runtime, view } = await mountSteward(
      vi.fn().mockResolvedValue({ ok: true, value: statusOf() }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Idle')
    })
    expect(view.container.textContent).toContain('Auto-accept')
    expect(view.container.textContent).toContain('Pending backlog: 0')
    expect(view.container.textContent).toContain('No steward activity yet')
    await runtime.dispose()
  })

  test('a busy steward with backlog and activity renders the feed newest first', async () => {
    const { runtime, view } = await mountSteward(
      vi.fn().mockResolvedValue({
        ok: true,
        value: statusOf({
          busy: true,
          backlog: 2,
          mode: 'confirm',
          activity: [
            // The host serves the ring newest first.
            { at: 2000, kind: 'eval-decision', text: 'accept · Fix the login flow' },
            { at: 1000, kind: 'eval-start', text: 'PROJ-1 (+3)' },
          ],
        }),
      }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Working')
    })
    expect(view.container.textContent).toContain('Ask first')
    expect(view.container.textContent).toContain('Pending backlog: 2')
    // Newest first: the decision precedes the eval start in the feed.
    const decisionAt = view.container.textContent.indexOf('accept · Fix the login flow')
    const startAt = view.container.textContent.indexOf('PROJ-1 (+3)')
    expect(decisionAt).toBeGreaterThan(-1)
    expect(startAt).toBeGreaterThan(-1)
    expect(decisionAt).toBeLessThan(startAt)
    await runtime.dispose()
  })

  test('a failing status read offers the retry affordance', async () => {
    const stewardStatus = vi.fn().mockRejectedValue(new Error('transport down'))
    const { runtime, view } = await mountSteward(stewardStatus)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Reading the steward status failed')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Read failed; click to retry' }))
    await vi.waitFor(() => {
      expect(stewardStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    await runtime.dispose()
  })

  test('Monitor tab keeps Eval records accessible even when steward status fails', async () => {
    const stewardStatus = vi.fn().mockRejectedValue(new Error('transport down'))
    const runtime = await SlotTestRuntime.create()
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.ctx.slots.installLocale(locale)
    await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
    runtime.remote.provideNamespaces({
      dshManager: {
        stewardStatus,
        evalList: vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } }),
        connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
      },
    })
    await runtime.mount({ inject: UI_INJECT, apply: registerUi })
    const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
    fireEvent.click(view.view.getByRole('tab', { name: 'Monitor' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Reading the steward status failed')
      expect(view.container.textContent).toContain('No eval records yet')
    })
    await runtime.dispose()
  })
})
