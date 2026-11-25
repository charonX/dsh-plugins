// @vitest-environment jsdom
/** Slot-tier specs for the eval records page against a scripted Remote namespace. */
import { fireEvent } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { EvalRecordView } from '../../src/evals/wire-types.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'
import { settingsStubs } from './settings-stubs.ts'

function pickOption(trigger: Element, label: string | RegExp): void {
  fireEvent.click(trigger)
  const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
  const item = items.find(el => typeof label === 'string' ? el.textContent?.trim() === label : label.test(el.textContent ?? ''))
  if (item === undefined) throw new Error(`menu item not found: ${String(label)}`)
  fireEvent.click(item)
}

function evalOf(overrides: Partial<EvalRecordView> & Pick<EvalRecordView, 'id' | 'threadId' | 'status' | 'startedAt' | 'policyVersion'>): EvalRecordView {
  return {
    triggers: [],
    ...overrides,
  }
}

/** Mount the eval records UI against a runtime whose Remote reads are scripted. */
async function mountEvals(
  evalList: ReturnType<typeof vi.fn>,
  connectionList: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
  extra: Record<string, ReturnType<typeof vi.fn>> = {},
): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({ dshManager: { ...settingsStubs(), evalList, connectionList, ...extra } })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  // The single tabbed panel defaults to the board; eval records are the default sub-view of Monitor.
  fireEvent.click(view.view.getByRole('tab', { name: 'Monitor' }))
  return { runtime, view }
}

describe('eval records page', () => {
  test('shows the empty copy while no eval has run', async () => {
    const { runtime, view } = await mountEvals(
      vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No eval records yet')
    })
    expect(view.container.textContent).not.toContain('Loading')
    await runtime.dispose()
  })

  test('renders decision badges, rationale, batch links, and policy facts', async () => {
    const { runtime, view } = await mountEvals(
      vi.fn().mockResolvedValue({
        ok: true,
        value: {
          evals: [
            evalOf({
              id: 'eval-1', threadId: 'thr-1', status: 'accepted',
              startedAt: 1000, policyVersion: '1',
              sourceConnectionId: 'conn-1',
              decision: {
                action: 'accept', strength: 'explicit', scope: 'the triggered change',
                policyVersion: '1', rationale: 'the issue explicitly asks for a fix', decidedAt: 2000,
              },
              triggers: [{ id: 'trg-1', externalKey: 'PROJ-1', url: 'https://jira.example.com/browse/PROJ-1' }],
            }),
            evalOf({
              id: 'eval-2', threadId: 'thr-2', status: 'incomplete',
              startedAt: 500, policyVersion: '1',
              decision: {
                action: 'incomplete', strength: 'inferred',
                policyVersion: '1', rationale: 'abandoned after 2 inconclusive runs', decidedAt: 900,
              },
            }),
          ],
        },
      }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [{ id: 'conn-1', connector: 'jira', name: 'Work Jira' }] },
      }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('the issue explicitly asks for a fix')
    })
    const text = view.container.textContent ?? ''
    // Decision badges in the localized vocabulary.
    expect(text).toContain('Accept')
    expect(text).toContain('Incomplete')
    // The rationale, thread, policy, and strength facts.
    expect(text).toContain('abandoned after 2 inconclusive runs')
    expect(text).toContain('thr-1')
    expect(text).toContain('Policy version: 1')
    expect(text).toContain('Explicit evidence')
    expect(text).toContain('Scope: the triggered change')
    // The source renders by connection name; the unnamed eval falls back to its thread.
    expect(text).toContain('Work Jira')
    expect(text).toContain('thr-2')
    // The batch carries the external link.
    const link = view.container.querySelector('a[href="https://jira.example.com/browse/PROJ-1"]')
    expect(link?.textContent).toContain('View PROJ-1')
    await runtime.dispose()
  })

  test('the decision-type filter re-reads with the chosen action', async () => {
    const evalList = vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } })
    const { runtime, view } = await mountEvals(evalList)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No eval records yet')
    })
    expect(evalList).toHaveBeenCalledWith({})
    // The first selector is the decision-type filter.
    pickOption(view.container.querySelectorAll('[data-select-control]')[0]!, 'Accept')
    await vi.waitFor(() => {
      expect(evalList).toHaveBeenCalledWith({ action: 'accept' })
    })
    await runtime.dispose()
  })

  test('the source filter re-reads with the chosen connection', async () => {
    const evalList = vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } })
    const { runtime, view } = await mountEvals(
      evalList,
      vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [{ id: 'conn-1', connector: 'jira', name: 'Work Jira' }] },
      }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No eval records yet')
    })
    pickOption(view.container.querySelectorAll('[data-select-control]')[1]!, 'Work Jira')
    await vi.waitFor(() => {
      expect(evalList).toHaveBeenCalledWith({ connectionId: 'conn-1' })
    })
    await runtime.dispose()
  })

  test('filters survive a reset-triggered re-read', async () => {
    const evalList = vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } })
    const { runtime, view } = await mountEvals(evalList)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No eval records yet')
    })
    pickOption(view.container.querySelectorAll('[data-select-control]')[0]!, 'Incomplete')
    await vi.waitFor(() => {
      expect(evalList).toHaveBeenCalledWith({ action: 'incomplete' })
    })
    runtime.ctx.emit('connection/reset')
    await vi.waitFor(() => {
      expect(evalList).toHaveBeenLastCalledWith({ action: 'incomplete' })
    })
    // The board's background pool read also polls this endpoint with a bare
    // filter; only the page's own filtered re-reads count here.
    const filteredCalls = evalList.mock.calls.filter(([input]) => (input as { action?: string } | undefined)?.action === 'incomplete')
    expect(filteredCalls).toHaveLength(2)
    await runtime.dispose()
  })

  test('a rejecting first read renders the retry affordance', async () => {
    const { runtime, view } = await mountEvals(
      vi.fn().mockRejectedValue(new Error('transport down')),
      vi.fn().mockRejectedValue(new Error('transport down')),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Failed to load')
    })
    await runtime.dispose()
  })

  test('a failed later read keeps the last rows; a reset re-reads', async () => {
    const good = {
      ok: true as const,
      value: {
        evals: [evalOf({
          id: 'eval-1', threadId: 'thr-1', status: 'rejected',
          startedAt: 1000, policyVersion: '1',
          decision: {
            action: 'ignore', strength: 'inferred',
            policyVersion: '1', rationale: 'not actionable', decidedAt: 1500,
          },
        })],
      },
    }
    const bad = { ok: false as const, error: { code: 'gateway/internal', message: 'boom' } }
    // The board mounts first with the panel and reads this endpoint for its
    // pool; the page's own first read follows, then the reset re-read fails.
    const evalList = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { evals: [] } })
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(bad)
      .mockResolvedValue({ ok: true, value: { evals: [] } })
    const { runtime, view } = await mountEvals(evalList)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('not actionable')
    })
    runtime.ctx.emit('connection/reset')
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Failed to load')
    })
    // The error page keeps the last rows behind the retry affordance.
    expect(evalList).toHaveBeenCalledTimes(3)
    await runtime.dispose()
  })
})

describe('eval records navigation entry', () => {
  test('registers a decorative icon into the sidebar panellist', async () => {
    const { runtime } = await mountEvals(vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } }))
    const view = runtime.renderSlot('sidebar.panellist', {})
    expect(view.container.querySelector('svg')).not.toBeNull()
    await runtime.dispose()
  })
})

describe('eval records flow view', () => {
  test('an accepted record whose ticket walks a pipeline carries the flow badge', async () => {
    const { runtime, view } = await mountEvals(
      vi.fn().mockResolvedValue({
        ok: true,
        value: {
          evals: [
            evalOf({
              id: 'eval-1', threadId: 'thr-1', status: 'accepted',
              startedAt: 1000, policyVersion: '1',
              decision: {
                action: 'accept', strength: 'explicit', scope: 'the triggered change',
                policyVersion: '1', rationale: 'the issue explicitly asks for a fix', decidedAt: 2000,
              },
              flow: { pipelineName: 'Test line', stageIndex: 1, stageCount: 3 },
            }),
          ],
        },
      }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Test line · stage 2/3')
    })
    await runtime.dispose()
  })
})
