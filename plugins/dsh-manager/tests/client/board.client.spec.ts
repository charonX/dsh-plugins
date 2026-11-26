// @vitest-environment jsdom
/** Slot-tier specs for the board page against a scripted Remote namespace. */
import { fireEvent, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { BoardSummary, TicketView } from '../../src/index.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'

/** The open modal, portal-mounted on document.body; queries must scope here. */
function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) throw new Error('the dialog is not open')
  return el
}

function openInfo(): void {
  const details = dialogEl().querySelector('details')
  if (!(details instanceof HTMLDetailsElement)) throw new Error('the ticket info disclosure is missing')
  details.open = true
}

type ColumnId = 'inbox' | 'pool' | 'todo' | 'running' | 'attention' | 'ended'
const COLUMN_IDS: readonly ColumnId[] = ['inbox', 'pool', 'todo', 'running', 'attention', 'ended']

function summaryOf(counts: Partial<Record<ColumnId, number>>): BoardSummary {
  return {
    columns: COLUMN_IDS.map(id => ({ id, count: counts[id] ?? 0 })),
  }
}

function ticketOf(overrides: Partial<TicketView> & Pick<TicketView, 'id' | 'title' | 'state'>): TicketView {
  return {
    threadId: 'thr-a',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** Mount the board UI against a runtime whose Remote reads are scripted. */
async function mountBoard(
  summary: ReturnType<typeof vi.fn>,
  ticketList: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
  extras: {
    candidateList?: ReturnType<typeof vi.fn>
    acceptCandidate?: ReturnType<typeof vi.fn>
    evalList?: ReturnType<typeof vi.fn>
    evalRequeue?: ReturnType<typeof vi.fn>
    manualInput?: ReturnType<typeof vi.fn>
    connectionList?: ReturnType<typeof vi.fn>
    projectList?: ReturnType<typeof vi.fn>
    ticketDetail?: ReturnType<typeof vi.fn>
    ticketChangeDiff?: ReturnType<typeof vi.fn>
    dispatchTicket?: ReturnType<typeof vi.fn>
    dispatchCancel?: ReturnType<typeof vi.fn>
    setTicketDependencies?: ReturnType<typeof vi.fn>
    closeTicket?: ReturnType<typeof vi.fn>
    ticketWorktree?: ReturnType<typeof vi.fn>
    ticketWorktreeRemove?: ReturnType<typeof vi.fn>
    attentionList?: ReturnType<typeof vi.fn>
    answerAttention?: ReturnType<typeof vi.fn>
    notificationList?: ReturnType<typeof vi.fn>
  } = {},
): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  // The locale plugin's product face: the renderer needs it for `t` seats.
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      summary,
      ticketList,
      candidateList: extras.candidateList ?? vi.fn().mockResolvedValue({ ok: true, value: { candidates: [] } }),
      acceptCandidate: extras.acceptCandidate ?? vi.fn().mockResolvedValue({ ok: true }),
      evalList: extras.evalList ?? vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } }),
      evalRequeue: extras.evalRequeue ?? vi.fn().mockResolvedValue({ ok: true, value: {} }),
      manualInput: extras.manualInput ?? vi.fn().mockResolvedValue({ ok: true, value: { threadId: 'thr-manual' } }),
      connectionList: extras.connectionList ?? vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
      projectList: extras.projectList ?? vi.fn().mockResolvedValue({ ok: true, value: { projects: [] } }),
      ticketDetail: extras.ticketDetail ?? vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      ticketChangeDiff: extras.ticketChangeDiff ?? vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      ...(extras.dispatchTicket === undefined ? {} : { dispatchTicket: extras.dispatchTicket }),
      ...(extras.dispatchCancel === undefined ? {} : { dispatchCancel: extras.dispatchCancel }),
      ...(extras.setTicketDependencies === undefined ? {} : { setTicketDependencies: extras.setTicketDependencies }),
      ...(extras.closeTicket === undefined ? {} : { closeTicket: extras.closeTicket }),
      ...(extras.ticketWorktree === undefined ? {} : { ticketWorktree: extras.ticketWorktree }),
      ...(extras.ticketWorktreeRemove === undefined ? {} : { ticketWorktreeRemove: extras.ticketWorktreeRemove }),
      attentionList: extras.attentionList ?? vi.fn().mockResolvedValue({ ok: true, value: { attentions: [] } }),
      answerAttention: extras.answerAttention ?? vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      notificationList: extras.notificationList ?? vi.fn().mockResolvedValue({ ok: true, value: { notifications: [] } }),
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  return { runtime, view }
}

describe('board page', () => {
  test('shows the empty-board copy while every column reads zero', async () => {
    const { runtime, view } = await mountBoard(vi.fn().mockResolvedValue({ ok: true, value: summaryOf({}) }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No tickets yet')
    })
    expect(view.container.textContent).not.toContain('Loading')
    await runtime.dispose()
  })

  test('renders column counts and compact ticket cards; clicking a card opens full detail', async () => {
    const ticketDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: ticketOf({
          id: 'ticket-1', title: 'Fix the login flow', state: 'todo',
          sourceConnectionId: 'conn-1', externalKey: 'PROJ-1',
          projectId: 'proj-alpha', threadId: 'thr-1',
          mandate: { strength: 'explicit', scope: 'the triggered change', policyVersion: '1' },
        }),
        dispatches: [],
        deliverables: [],
        changes: [],
        followUps: [],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1, running: 1, attention: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: {
          tickets: [
            ticketOf({
              id: 'ticket-1', title: 'Fix the login flow', state: 'todo',
              sourceConnectionId: 'conn-1', externalKey: 'PROJ-1',
              projectId: 'proj-alpha', threadId: 'thr-1',
              mandate: { strength: 'explicit', scope: 'the triggered change', policyVersion: '1' },
            }),
            ticketOf({ id: 'ticket-2', title: 'Ship the report', state: 'running', threadId: 'thr-2' }),
          ],
        },
      }),
      { ticketDetail },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Fix the login flow')
    })
    expect(view.container.textContent).toContain('Todo')
    expect(view.container.textContent).toContain('Running')
    expect(view.container.textContent).toContain('Attention')
    expect(view.container.textContent).toContain('Ship the report')
    // The card shows primary info (source & project) while omitting verbose thread/mandate text.
    expect(view.container.textContent).toContain('PROJ-1')
    expect(view.container.textContent).toContain('proj-alpha')
    expect(view.container.textContent).not.toContain('thr-1')
    expect(view.container.textContent).not.toContain('the triggered change')

    // Clicking the card title itself opens the detail panel (never navigates externally, even with empty or external url).
    const titleEl = view.view.getByText('Fix the login flow')
    expect(titleEl.closest('a')).toBeNull()
    fireEvent.click(titleEl)
    await vi.waitFor(() => {
      expect(ticketDetail).toHaveBeenCalledWith({ ticketId: 'ticket-1' })
      expect(dialogEl().textContent).toContain('thr-1')
      expect(dialogEl().textContent).toContain('the triggered change')
    })
    await runtime.dispose()
  })

  test('a ticket with empty string url (e.g. manual entry) renders no empty-href anchor on card or in detail', async () => {
    const manualTicket = ticketOf({
      id: 'ticket-manual',
      title: 'Manual analysis task',
      state: 'todo',
      sourceConnectionId: 'manual',
      externalKey: 'manual-17e862dc',
      url: '',
      threadId: 'thr-manual',
    })
    const ticketDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: manualTicket,
        dispatches: [],
        deliverables: [],
        changes: [],
        followUps: [],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [manualTicket] } }),
      { ticketDetail },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Manual analysis task')
    })
    expect(view.container.querySelector('a[href=""]')).toBeNull()
    fireEvent.click(view.view.getByText('Manual analysis task'))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('manual-17e862dc')
    })
    expect(dialogEl().querySelector('a[href=""]')).toBeNull()
    await runtime.dispose()
  })

  test('renders the fanned-in triggers on a live ticket card', async () => {
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: {
          tickets: [
            ticketOf({
              id: 'ticket-1', title: 'Fix the login flow', state: 'todo', threadId: 'thr-1',
              fanIn: [{ id: 'trg-9', externalKey: 'group/alpha!12', url: 'https://gl.example.com/mr/12#note_3', collectedAt: 300 }],
            }),
          ],
        },
      }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('New change on group/alpha!12')
    })
    const link = view.container.querySelector('a[href="https://gl.example.com/mr/12#note_3"]')
    expect(link).not.toBeNull()
    await runtime.dispose()
  })

  test('renders the newest timeline event and its relative time on the card', async () => {
    const at = Date.now() - 5 * 60_000
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ running: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: {
          tickets: [
            ticketOf({
              id: 'ticket-activity', title: 'Rename the drawer heading', state: 'running', threadId: 'thr-2',
              lastActivity: { at, kind: 'instruction', author: 'user', text: '把标题改成工作台' },
            }),
          ],
        },
      }),
    )
    await vi.waitFor(() => {
      const text = view.container.textContent ?? ''
      expect(text).toContain('把标题改成工作台')
      expect(text).toContain('5m ago')
    })
    await runtime.dispose()
  })

  test('a rejecting first read renders the retry affordance', async () => {
    const { runtime, view } = await mountBoard(
      vi.fn().mockRejectedValue(new Error('transport down')),
      vi.fn().mockRejectedValue(new Error('transport down')),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Failed to load')
    })
    await runtime.dispose()
  })

  test('a failed later read keeps the last summary; a reset re-reads', async () => {
    const summary = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: summaryOf({ todo: 1 }) })
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/internal', message: 'boom' } })
    const ticketList = vi.fn().mockResolvedValue({
      ok: true,
      value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'todo' })] },
    })
    const { runtime, view } = await mountBoard(summary, ticketList)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Todo')
    })
    // A connection reset states that the wire moved, so the source re-reads.
    runtime.ctx.emit('connection/reset')
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Failed to load')
    })
    expect(summary).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  })

  test('a reset re-read picks up newly accepted tickets', async () => {
    const summary = vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1 }) })
    const ticketList = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'todo' })] },
      })
      .mockResolvedValue({
        ok: true,
        value: {
          tickets: [
            ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'todo' }),
            ticketOf({ id: 'ticket-2', title: 'Ship the report', state: 'todo' }),
          ],
        },
      })
    const { runtime, view } = await mountBoard(summary, ticketList)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Fix the login flow')
    })
    expect(view.container.textContent).not.toContain('Ship the report')
    runtime.ctx.emit('connection/reset')
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Ship the report')
    })
    expect(ticketList).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  })
  test('the inbox shows candidates with an accept button that mints the ticket', async () => {
    const candidateList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        candidates: [
          { evalId: 'eval-1', threadId: 'thr-1', title: 'Fix the login flow', externalKey: 'PROJ-1', rationale: 'a related comment', strength: 'inferred' },
        ],
      },
    })
    const acceptCandidate = vi.fn().mockResolvedValue({ ok: true })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ inbox: 1 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      { candidateList, acceptCandidate },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Fix the login flow')
    })
    expect(view.container.textContent).toContain('a related comment')
    const accept = view.view.getByRole('button', { name: 'Accept' }) as HTMLButtonElement
    expect(accept).not.toBeNull()
    accept.click()
    await vi.waitFor(() => {
      expect(acceptCandidate).toHaveBeenCalledWith({ evalId: 'eval-1' })
    })
    await runtime.dispose()
  })
  test('the pool column renders retired evals with status badges', async () => {
    const evalList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        evals: [
          {
            id: 'eval-1', threadId: 'thr-1', status: 'incomplete', startedAt: 100, finishedAt: 200,
            policyVersion: '1',
            triggers: [{ id: 'trg-1', externalKey: 'PROJ-11', url: 'https://jira.example.com/browse/PROJ-11' }],
          },
          {
            id: 'eval-2', threadId: 'thr-2', status: 'failed', startedAt: 300, finishedAt: 400,
            policyVersion: '1',
            decision: { action: 'skip', policyVersion: '1', rationale: 'the change is a duplicate of PROJ-3', decidedAt: 400 },
            triggers: [{ id: 'trg-2', externalKey: 'PROJ-12', url: 'https://jira.example.com/browse/PROJ-12' }],
          },
          // A live status is not pool material; it must not render.
          { id: 'eval-3', threadId: 'thr-3', status: 'accepted', startedAt: 500, policyVersion: '1', triggers: [] },
        ],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ pool: 2 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      { evalList },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Rework pool')
    })
    expect(view.container.textContent).toContain('PROJ-11')
    expect(view.container.textContent).toContain('PROJ-12')
    expect(view.container.textContent).toContain('Incomplete')
    expect(view.container.textContent).toContain('Failed')
    expect(view.container.textContent).toContain('the change is a duplicate of PROJ-3')
    // The live eval never reached the pool.
    expect(view.container.textContent).not.toContain('thr-3')
    // Pool cards are draggable with the checkbox selection affordance.
    const poolCards = view.container.querySelectorAll('li[data-state="pool"]')
    expect(poolCards).toHaveLength(2)
    expect(poolCards[0].getAttribute('draggable')).toBe('true')
    expect(poolCards[0].querySelector('input[type="checkbox"]')).not.toBeNull()
    await runtime.dispose()
  })
  test('selecting pool cards and re-evaluating them calls evalRequeue per id and refreshes', async () => {
    const evalList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        evals: [
          {
            id: 'eval-1', threadId: 'thr-1', status: 'incomplete', startedAt: 100, finishedAt: 200,
            policyVersion: '1',
            triggers: [{ id: 'trg-1', externalKey: 'PROJ-11', url: 'https://jira.example.com/browse/PROJ-11' }],
          },
          {
            id: 'eval-2', threadId: 'thr-2', status: 'failed', startedAt: 300, finishedAt: 400, policyVersion: '1',
            triggers: [{ id: 'trg-2', externalKey: 'PROJ-12', url: 'https://jira.example.com/browse/PROJ-12' }],
          },
        ],
      },
    })
    const evalRequeue = vi.fn().mockResolvedValue({ ok: true, value: {} })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ pool: 2 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      { evalList, evalRequeue },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('PROJ-11')
    })
    // Select both pool cards; the bulk bar appears with the count and actions.
    const checkboxes = view.container.querySelectorAll('li[data-state="pool"] input[type="checkbox"]')
    fireEvent.click(checkboxes[0])
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('1 selected')
    })
    fireEvent.click(checkboxes[1])
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('2 selected')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Re-evaluate' }))
    await vi.waitFor(() => {
      expect(evalRequeue).toHaveBeenCalledTimes(2)
      expect(evalRequeue).toHaveBeenCalledWith({ evalId: 'eval-1' })
      expect(evalRequeue).toHaveBeenCalledWith({ evalId: 'eval-2' })
    })
    // The bulk bar clears once the batch is handed back.
    await vi.waitFor(() => {
      expect(view.container.textContent).not.toContain('2 selected')
    })
    await runtime.dispose()
  })
  test('applying the search filter re-reads the board carrying the search text', async () => {
    const summary = vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1 }) })
    const { runtime, view } = await mountBoard(summary)
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Todo')
    })
    expect(summary).toHaveBeenLastCalledWith({})
    fireEvent.change(view.view.getByPlaceholderText('Title or external key…'), { target: { value: 'PROJ-42' } })
    fireEvent.click(view.view.getByRole('button', { name: 'Apply' }))
    await vi.waitFor(() => {
      expect(summary).toHaveBeenLastCalledWith({ search: 'PROJ-42' })
    })
    // Clearing the field drops the filter field.
    fireEvent.change(view.view.getByPlaceholderText('Title or external key…'), { target: { value: '' } })
    fireEvent.click(view.view.getByRole('button', { name: 'Apply' }))
    await vi.waitFor(() => {
      expect(summary).toHaveBeenLastCalledWith({})
    })
    await runtime.dispose()
  })
  test('the manual-entry modal submits the composed input and closes on success', async () => {
    const manualInput = vi.fn().mockResolvedValue({ ok: true, value: { threadId: 'thr-manual' } })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({}) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      { manualInput },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Enter a task manually')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Enter a task manually' }))
    const dialog = dialogEl()
    fireEvent.change(within(dialog).getByPlaceholderText('What needs doing?'), { target: { value: 'Write the release note' } })
    fireEvent.change(within(dialog).getByPlaceholderText('Context, goal, and constraints…'), { target: { value: 'Summarize the shipped changes' } })
    const submit = within(dialog).getByRole('button', { name: 'Submit' }) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await vi.waitFor(() => {
      expect(manualInput).toHaveBeenCalledWith({ title: 'Write the release note', description: 'Summarize the shipped changes' })
    })
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    await runtime.dispose()
  })

  test('changing a filter re-reads the board carrying the filter payload', async () => {
    const summary = vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1 }) })
    const ticketList = vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } })
    const { runtime, view } = await mountBoard(summary, ticketList, {
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [{ id: 'conn-1', connector: 'jira', name: 'jira-prod' }] },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Todo')
    })
    expect(summary).toHaveBeenLastCalledWith({})
    const pickOption = (trigger: HTMLElement, label: string): void => {
      fireEvent.click(trigger)
      const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find(el => el.textContent?.trim() === label)
      if (item === undefined) throw new Error(`menu item not found: ${label}`)
      fireEvent.click(item)
    }
    pickOption(view.view.getByLabelText('Kind'), 'Jira issues')
    await vi.waitFor(() => {
      expect(summary).toHaveBeenLastCalledWith({ kind: 'jira' })
      expect(ticketList).toHaveBeenLastCalledWith({ kind: 'jira' })
      // The committed select shows the new filter before the next change.
      expect(view.view.getByLabelText('Kind').getAttribute('data-value')).toBe('jira')
    })
    // Combining keeps the earlier field: the payload is an intersection.
    pickOption(view.view.getByLabelText('Connection'), 'jira-prod')
    await vi.waitFor(() => {
      expect(summary).toHaveBeenLastCalledWith({ connectionId: 'conn-1', kind: 'jira' })
      expect(view.view.getByLabelText('Connection').getAttribute('data-value')).toBe('conn-1')
    })
    // Choosing "All" drops just that field, keeping the rest.
    pickOption(view.view.getByLabelText('Kind'), 'All')
    await vi.waitFor(() => {
      expect(summary).toHaveBeenLastCalledWith({ connectionId: 'conn-1' })
      expect(view.view.getByLabelText('Kind').getAttribute('data-value')).toBe('')
    })
    await runtime.dispose()
  })

  test('the filter persists through localStorage and a fresh mount restores it', async () => {
    const summary = vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1 }) })
    const { runtime, view } = await mountBoard(
      summary,
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      {
        projectList: vi.fn().mockResolvedValue({
          ok: true,
          value: { projects: [{ id: 'proj-alpha', name: 'Alpha' }] },
        }),
      },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Todo')
    })
    fireEvent.click(view.view.getByLabelText('Project'))
    const alphaItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(el => el.textContent?.trim() === 'Alpha')
    expect(alphaItem).toBeDefined()
    fireEvent.click(alphaItem!)
    await vi.waitFor(() => {
      expect(summary).toHaveBeenLastCalledWith({ projectId: 'proj-alpha' })
      expect(view.view.getByLabelText('Project').getAttribute('data-value')).toBe('proj-alpha')
    })
    // The change landed in the persisted filter record.
    expect(globalThis.localStorage?.getItem('dsh-manager.board.filter'))
      .toBe(JSON.stringify({ projectId: 'proj-alpha' }))
    await runtime.dispose()
    // A fresh mount (storage pre-seeded; the test runtime clears it on dispose)
    // reads the persisted filter and carries it on its first read.
    globalThis.localStorage?.setItem('dsh-manager.board.filter', JSON.stringify({ projectId: 'proj-alpha' }))
    const summary2 = vi.fn().mockResolvedValue({ ok: true, value: summaryOf({}) })
    const { runtime: runtime2, view: view2 } = await mountBoard(
      summary2,
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      {
        projectList: vi.fn().mockResolvedValue({
          ok: true,
          value: { projects: [{ id: 'proj-alpha', name: 'Alpha' }] },
        }),
      },
    )
    await vi.waitFor(() => {
      expect(summary2).toHaveBeenLastCalledWith({ projectId: 'proj-alpha' })
      expect(view2.view.getByLabelText('Project').getAttribute('data-value')).toBe('proj-alpha')
    })
    await runtime2.dispose()
    globalThis.localStorage?.removeItem('dsh-manager.board.filter')
  })

  test('the filter selects list the host connections and projects', async () => {
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({}) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      {
        connectionList: vi.fn().mockResolvedValue({
          ok: true,
          value: { connections: [{ id: 'conn-1', connector: 'jira', name: 'jira-prod' }] },
        }),
        projectList: vi.fn().mockResolvedValue({
          ok: true,
          value: { projects: [{ id: 'proj-alpha', name: 'Alpha' }] },
        }),
      },
    )
    await vi.waitFor(() => {
      expect(view.view.getByLabelText('Connection')).toBeDefined()
    })
    fireEvent.click(view.view.getByLabelText('Connection'))
    await vi.waitFor(() => {
      expect(Array.from(document.body.querySelectorAll('[role="menuitem"]')).map(el => el.textContent?.trim())).toContain('jira-prod')
    })
    fireEvent.click(view.view.getByLabelText('Project'))
    await vi.waitFor(() => {
      expect(Array.from(document.body.querySelectorAll('[role="menuitem"]')).map(el => el.textContent?.trim())).toContain('Alpha')
    })
    await runtime.dispose()
  })

  test('a failing connection or project read does not break the board', async () => {
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      {
        connectionList: vi.fn().mockRejectedValue(new Error('transport down')),
        projectList: vi.fn().mockRejectedValue(new Error('transport down')),
      },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Todo')
    })
    await runtime.dispose()
  })

  test('a ticket card opens a detail panel with dispatches, deliverables, and a resolvable diff', async () => {
    const ticketDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'ended', threadId: 'thr-1' }),
        dispatches: [
          {
            id: 'dispatch-1', ticketId: 'ticket-1', state: 'ended', outcome: 'ready',
            sessionId: 'sess-1', reports: [{ id: 'report-1', kind: 'progress', message: 'working', at: 1 }, { id: 'report-2', kind: 'ready', message: 'the analysis is complete', at: 2 }],
            createdAt: 1, updatedAt: 2,
          },
        ],
        deliverables: [{ sessionId: 'sess-1', turn: 3, index: 0, path: 'finding-1.md', description: 'The analysis notes' }],
        changes: [{ sessionId: 'sess-1', seq: 7, turn: 3, files: 1 }],
        followUps: [],
      },
    })
    const ticketChangeDiff = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        diff: {
          kind: 'text', path: 'finding-1.md', display: 'finding-1.md',
          before: false, after: true, coarse: false,
          hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+findings from executor call 1'] }],
        },
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ ended: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'ended' })] },
      }),
      { ticketDetail, ticketChangeDiff },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Fix the login flow')
    })
    // Opening the detail reads the whole ticket view from the host.
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(ticketDetail).toHaveBeenCalledWith({ ticketId: 'ticket-1' })
      expect(view.view.getByRole('dialog', { name: 'Ticket detail' })).not.toBeNull()
    })
    // The dispatch history shows the state, outcome, and latest meaningful report.
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Ended')
      expect(view.container.textContent).toContain('Ready')
      expect(view.container.textContent).toContain('the analysis is complete')
    })
    // The deliverable reference is the session id + turn, never a copy.
    expect(view.container.textContent).toContain('finding-1.md')
    expect(view.container.textContent).toContain('sess-1')
    // The workspace-changes ref resolves through the harness diff view.
    fireEvent.click(view.view.getByRole('button', { name: '#1' }))
    await vi.waitFor(() => {
      expect(ticketChangeDiff).toHaveBeenCalledWith({ sessionId: 'sess-1', seq: 7, index: 0 })
      expect(view.container.textContent).toContain('findings from executor call 1')
    })
    const addRow = view.container.querySelector('[data-diff="add"]')
    expect(addRow).not.toBeNull()
    // Closing the panel unmounts it.
    fireEvent.click(view.view.getByRole('button', { name: 'Close' }))
    await vi.waitFor(() => {
      expect(view.view.queryByRole('dialog')).toBeNull()
    })
    await runtime.dispose()
  })

  test('a failed detail read shows the failure copy instead of the panel body', async () => {
    const ticketDetail = vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'boom' } })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'todo' })] },
      }),
      { ticketDetail },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Fix the login flow')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Failed to load')
    })
    await runtime.dispose()
  })

  test('a pending attention shows on the card with an answer form that submits and refreshes', async () => {
    let pending = [{ id: 'att-1', ticketId: 'ticket-1', dispatchId: 'dispatch-1', kind: 'question', question: 'Which database?', status: 'pending', createdAt: 1, updatedAt: 1 }]
    const attentionList = vi.fn().mockImplementation(async () => ({
      ok: true,
      value: { attentions: pending },
    }))
    const answerAttention = vi.fn().mockImplementation(async () => {
      pending = []
      return { ok: true }
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ attention: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'attention' })] },
      }),
      { attentionList, answerAttention },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Fix the login flow')
    })
    // The card shows the pending attention count and the question.
    expect(view.container.textContent).toContain('1 pending')
    expect(view.container.textContent).toContain('Which database?')
    // The answer form submits through the host and the card refreshes.
    fireEvent.change(view.view.getByPlaceholderText('Type your answer…'), { target: { value: 'Use Postgres' } })
    fireEvent.click(view.view.getByRole('button', { name: 'Answer' }))
    await vi.waitFor(() => {
      expect(answerAttention).toHaveBeenCalledWith({ attentionId: 'att-1', answer: 'Use Postgres' })
      expect(view.container.textContent).not.toContain('Which database?')
    })
    await runtime.dispose()
  })

  test('a suggested close shows Confirm close/Ignored; confirming answers confirmed, ignoring answers ignored', async () => {
    let pending = [{
      id: 'att-4', ticketId: 'ticket-1', dispatchId: 'steward', kind: 'suggest-end',
      question: 'the external object behind ticket ticket-1 has ended; suggest closing it',
      details: 'the merge request was merged',
      status: 'pending', createdAt: 1, updatedAt: 1,
    }]
    const attentionList = vi.fn().mockImplementation(async () => ({ ok: true, value: { attentions: pending } }))
    const answers: string[] = []
    const answerAttention = vi.fn().mockImplementation(async ({ answer }: { answer: string }) => {
      answers.push(answer)
      if (answers.length === 2) pending = []
      return { ok: true, value: {} }
    })
    const ticketDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'attention' }),
        dispatches: [],
        deliverables: [],
        changes: [],
        followUps: [],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ attention: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'attention' })] },
      }),
      { attentionList, answerAttention, ticketDetail },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('the external object behind ticket ticket-1')
    })
    // Detailed evidence stays off the compact card until clicked open.
    expect(view.container.textContent).not.toContain('the merge request was merged')
    // Ignoring answers `ignored` and the ticket stays open.
    fireEvent.click(view.view.getByRole('button', { name: 'Ignore' }))
    await vi.waitFor(() => {
      expect(answers).toEqual(['ignored'])
      expect((view.view.getByRole('button', { name: 'Confirm close' }) as HTMLButtonElement).disabled).toBe(false)
    })
    // Opening the card detail shows the full evidence and still allows confirming close.
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('the merge request was merged')
    })
    // Confirming inside the detail panel ends the ticket through the host's ending authority.
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Confirm close' }))
    await vi.waitFor(() => {
      expect(answers).toEqual(['ignored', 'confirmed'])
    })
    await runtime.dispose()
  })

  test('the detail panel shows the follow-up chain and jumps to linked tickets', async () => {
    const ticketDetail = vi.fn().mockImplementation(async ({ ticketId }: { ticketId: string }) => ({
      ok: true,
      value: {
        ticket: ticketOf({ id: ticketId, title: ticketId === 'ticket-1' ? 'Fix the login flow' : 'Track the pipeline result', state: 'todo' }),
        dispatches: [],
        deliverables: [],
        changes: [],
        ...(ticketId === 'ticket-1'
          ? { followUps: [{ id: 'ticket-2', title: 'Track the pipeline result', state: 'todo' }] }
          : { followUpOf: { id: 'ticket-1', title: 'Fix the login flow', state: 'todo' }, followUps: [] }),
      },
    }))
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 2 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'todo' })] },
      }),
      { ticketDetail },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Fix the login flow')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Ticket chain')
      expect(view.view.getByRole('button', { name: 'Track the pipeline result' })).not.toBeNull()
      expect(view.container.textContent).toContain('Follows up: none (minted directly from a Source)')
    })
    // Jumping to the follow-up opens its detail, which points back at the parent.
    fireEvent.click(view.view.getByRole('button', { name: 'Track the pipeline result' }))
    await vi.waitFor(async () => {
      expect(ticketDetail).toHaveBeenLastCalledWith({ ticketId: 'ticket-2' })
      expect(view.container.textContent).toContain('Follows up: Fix the login flow')
    })
    await runtime.dispose()
  })

  test('an approval attention shows Approve/Reject buttons; approving answers verbatim, rejecting carries the opinion', async () => {
    let pending = [{
      id: 'att-1', ticketId: 'ticket-1', dispatchId: 'dispatch-1', kind: 'approval',
      question: 'the executor requested comment through post_mr_comment',
      action: { category: 'comment', tool: 'post_mr_comment', payload: { body: 'LGTM from the executor' } },
      status: 'pending', createdAt: 1, updatedAt: 1,
    }]
    const attentionList = vi.fn().mockImplementation(async () => ({ ok: true, value: { attentions: pending } }))
    const answerAttention = vi.fn().mockImplementation(async ({ answer }: { answer: string }) => {
      pending = []
      return { ok: true, value: { ...pending, answer } }
    })
    const ticketDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: ticketOf({ id: 'ticket-1', title: 'Post the review comment', state: 'attention' }),
        dispatches: [],
        deliverables: [],
        changes: [],
        followUps: [],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ attention: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Post the review comment', state: 'attention' })] },
      }),
      { attentionList, answerAttention, ticketDetail },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('the executor requested comment')
    })
    // The verbose action payload is kept out of the compact board card and shown in full detail on click.
    expect(view.container.textContent).not.toContain('LGTM from the executor')
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('LGTM from the executor')
    })
    // Approving from the detail panel answers verbatim.
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Approve' }))
    await vi.waitFor(() => {
      expect(answerAttention).toHaveBeenCalledWith({ attentionId: 'att-1', answer: 'approved' })
    })
    await runtime.dispose()
  })

  test('rejecting an approval without an opinion still answers, with one it carries the opinion', async () => {
    let pending = [{
      id: 'att-2', ticketId: 'ticket-1', dispatchId: 'dispatch-1', kind: 'approval',
      question: 'the executor requested jira-transition through set_jira_status',
      action: { category: 'jira-transition', tool: 'set_jira_status', payload: { issueKey: 'PROJ-12' } },
      status: 'pending', createdAt: 1, updatedAt: 1,
    }]
    const attentionList = vi.fn().mockImplementation(async () => ({ ok: true, value: { attentions: pending } }))
    const answers: string[] = []
    const answerAttention = vi.fn().mockImplementation(async ({ answer }: { answer: string }) => {
      answers.push(answer)
      if (answers.length === 2) pending = []
      return { ok: true, value: {} }
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ attention: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Transition the issue', state: 'attention' })] },
      }),
      { attentionList, answerAttention },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('the executor requested jira-transition')
    })
    // A bare rejection answers without an opinion.
    fireEvent.click(view.view.getByRole('button', { name: 'Reject' }))
    await vi.waitFor(() => {
      expect(answers).toEqual(['rejected'])
      // The form cleared and the buttons recovered after the accepted answer.
      expect((view.view.getByPlaceholderText('Opinion to return on rejection (optional)…') as HTMLInputElement).value).toBe('')
      expect((view.view.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false)
    })
    // With an opinion typed, the rejection carries it.
    fireEvent.change(view.view.getByPlaceholderText('Opinion to return on rejection (optional)…'), { target: { value: 'use the API token first' } })
    fireEvent.click(view.view.getByRole('button', { name: 'Reject' }))
    await vi.waitFor(() => {
      expect(answers).toEqual(['rejected', 'rejected: use the API token first'])
    })
    await runtime.dispose()
  })

  test('an acceptance attention shows Pass/Return; passing answers approved, returning carries the opinion', async () => {
    let pending = [{
      id: 'att-3', ticketId: 'ticket-1', dispatchId: 'dispatch-1', kind: 'review',
      question: 'acceptance requested for ticket ticket-1: the Steward passed the result',
      details: 'meets the mandate',
      status: 'pending', createdAt: 1, updatedAt: 1,
    }]
    const attentionList = vi.fn().mockImplementation(async () => ({ ok: true, value: { attentions: pending } }))
    const answers: string[] = []
    const answerAttention = vi.fn().mockImplementation(async ({ answer }: { answer: string }) => {
      answers.push(answer)
      pending = []
      return { ok: true, value: {} }
    })
    const ticketDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'attention' }),
        dispatches: [],
        deliverables: [],
        changes: [],
        followUps: [],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ attention: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-1', title: 'Fix the login flow', state: 'attention' })] },
      }),
      { attentionList, answerAttention, ticketDetail },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('acceptance requested for ticket ticket-1')
    })
    // Detailed Steward acceptance summary is hidden on the compact card and shown in full detail on click.
    expect(view.container.textContent).not.toContain('meets the mandate')
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('meets the mandate')
    })
    // Returning with an opinion answers `rejected: …` so the work re-enters
    // execution with the opinion as its input.
    fireEvent.change(within(dialogEl()).getByPlaceholderText('Opinion to return with (optional)…'), { target: { value: 'the error path is still missing' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Return' }))
    await vi.waitFor(() => {
      expect(answers).toEqual(['rejected: the error path is still missing'])
    })
    await runtime.dispose()
  })

  test('a new notification toasts once and marks seen; the board entry badge shows the unseen count', async () => {
    const notificationList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        notifications: [
          { id: 'ntf-1', kind: 'attention', attentionId: 'att-1', ticketId: 'ticket-1', title: 'Which database?', at: 1 },
        ],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({}) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      { notificationList },
    )
    // The toast appears for the new notification, with its verbatim copy.
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('New pending attention')
      expect(view.container.textContent).toContain('Which database?')
    })
    // The same notification does not toast twice on the next poll.
    await vi.waitFor(() => {
      expect(notificationList).toHaveBeenCalledTimes(1)
    })
    expect(view.container.querySelectorAll('[role="status"] > div')).toHaveLength(1)
    // User can dismiss the toast immediately without waiting for timeout.
    fireEvent.click(view.view.getByRole('button', { name: 'Dismiss notification' }))
    expect(view.container.querySelectorAll('[role="status"] > div')).toHaveLength(0)
    await runtime.dispose()
  })

  test('auto-dismisses toast even when feed updates mid-timeout and shows escalation buttons', async () => {
    const answerAttention = vi.fn().mockResolvedValue({ ok: true, value: { id: 'att-esc', status: 'answered' } })
    const escalationTicket = ticketOf({ id: 'ticket-esc', title: 'Repeated failure', state: 'attention' })
    const attentionList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        attentions: [{
          id: 'att-esc',
          ticketId: 'ticket-esc',
          dispatchId: 'disp-3',
          kind: 'question',
          question: 'the Steward reworked ticket ticket-esc 2 times and it still falls short; decide whether to accept it or rework it yourself',
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    })
    const notificationList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        notifications: [{ id: 'ntf-esc', kind: 'attention', attentionId: 'att-esc', ticketId: 'ticket-esc', title: 'Repeated failure prompt', at: 1 }],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ attention: 1 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [escalationTicket] } }),
      { attentionList, answerAttention, notificationList },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Auto-rework limit reached')
      expect(view.container.textContent).toContain('Repeated failure prompt')
    })

    // Trigger another poll via connection/reset BEFORE 6s — old timer must NOT be cancelled.
    runtime.ctx.emit('connection/reset')
    await vi.waitFor(() => {
      expect(view.container.querySelectorAll('[role="status"] > div')).toHaveLength(0)
    }, { timeout: 8000 })

    // Escalation button passes and continues cleanly.
    fireEvent.click(view.view.getByRole('button', { name: 'Pass & continue' }))
    await vi.waitFor(() => {
      expect(answerAttention).toHaveBeenCalledWith({ attentionId: 'att-esc', answer: 'confirmed' })
    })
    await runtime.dispose()
  })

  test('watchdog stall attention renders Keep waiting and Abort dispatch quick actions', async () => {
    const answerAttention = vi.fn().mockResolvedValue({ ok: true, value: { id: 'att-stall', status: 'answered' } })
    const stallTicket = ticketOf({ id: 'att-t2', title: 'Long running compile', state: 'attention' })
    const attentionList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        attentions: [{
          id: 'att-stall',
          ticketId: 'att-t2',
          dispatchId: 'watchdog',
          kind: 'question',
          question: 'Dispatch d-1 on ticket att-t2 has made no progress for 650000 ms.',
          details: 'watchdog:stall:d-1',
          status: 'pending',
          createdAt: 100,
          updatedAt: 100,
        }],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ attention: 1 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [stallTicket] } }),
      { attentionList, answerAttention },
    )

    await vi.waitFor(() => {
      expect(view.view.queryByRole('button', { name: 'Keep waiting' })).not.toBeNull()
      expect(view.view.queryByRole('button', { name: 'Abort dispatch' })).not.toBeNull()
    }, { timeout: 8000 })

    fireEvent.click(view.view.getByRole('button', { name: 'Keep waiting' }))
    await vi.waitFor(() => {
      expect(answerAttention).toHaveBeenCalledWith({ attentionId: 'att-stall', answer: 'confirmed' })
      expect((view.view.getByRole('button', { name: 'Abort dispatch' }) as HTMLButtonElement).disabled).toBe(false)
    })

    fireEvent.click(view.view.getByRole('button', { name: 'Abort dispatch' }))
    await vi.waitFor(() => {
      expect(answerAttention).toHaveBeenCalledWith({ attentionId: 'att-stall', answer: 'rejected' })
    })
    await runtime.dispose()
  })

  test('clicking candidate or pool cards opens their full detail modal; interacting with inline controls does not', async () => {
    const candidateList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        candidates: [
          { evalId: 'eval-1', threadId: 'thr-cand', title: 'Investigate timeout', externalKey: 'PROJ-77', rationale: 'Full candidate rationale', strength: 'inferred' },
        ],
      },
    })
    const evalList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        evals: [
          {
            id: 'eval-2', threadId: 'thr-pool', status: 'failed', startedAt: 100, finishedAt: 200,
            policyVersion: '1',
            decision: { action: 'skip', policyVersion: '1', rationale: 'Full pool failure reason', decidedAt: 200 },
            triggers: [{ id: 'trg-9', externalKey: 'PROJ-88' }],
          },
        ],
      },
    })
    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ inbox: 1, pool: 1 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      { candidateList, evalList },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Investigate timeout')
      expect(view.container.textContent).toContain('PROJ-88')
    })

    // Clicking the candidate card opens CandidateDetailModal with thread & strength.
    const candCard = view.container.querySelector('li[data-state="inbox"]')
    expect(candCard).not.toBeNull()
    fireEvent.click(candCard!)
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('thr-cand')
      expect(dialogEl().textContent).toContain('Full candidate rationale')
      expect(dialogEl().textContent).toContain('Inferred evidence')
    })
    fireEvent.click(within(dialogEl()).getAllByRole('button', { name: 'Close' })[0])
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })

    // Checking the pool checkbox does not open the pool modal; clicking the card surface does.
    const poolCard = view.container.querySelector('li[data-state="pool"]')
    expect(poolCard).not.toBeNull()
    const checkbox = poolCard!.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(checkbox)
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    fireEvent.click(poolCard!)
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('thr-pool')
      expect(dialogEl().textContent).toContain('Full pool failure reason')
      expect(dialogEl().textContent).toContain('PROJ-88')
    })
    await runtime.dispose()
  })
})

describe('board navigation entry', () => {
  test('registers a decorative icon into the sidebar panellist', async () => {
    const { runtime } = await mountBoard(vi.fn().mockResolvedValue({ ok: true, value: summaryOf({}) }))
    const view = runtime.renderSlot('sidebar.panellist', {})
    expect(view.container.querySelector('svg')).not.toBeNull()
    await runtime.dispose()
  })

  test('the entry carries the unseen-notification badge', async () => {
    const notificationList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        notifications: [
          { id: 'ntf-1', kind: 'attention', attentionId: 'att-1', ticketId: 'ticket-1', title: 'Which database?', at: 1 },
          { id: 'ntf-2', kind: 'attention', attentionId: 'att-2', ticketId: 'ticket-2', title: 'Proceed without tests?', at: 2 },
        ],
      },
    })
    const { runtime } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({}) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      { notificationList },
    )
    const view = runtime.renderSlot('sidebar.panellist', {})
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('2')
    })
    expect(view.container.querySelector('[aria-hidden="true"]')).not.toBeNull()
    await runtime.dispose()
  })
})

describe('ticket detail activity, cancellation, and worktree diff/cleanup', () => {
  test('renders structured activity, cancels a running dispatch, previews worktree diff, and removes worktree', async () => {
    let running = true
    let worktreeExists = true
    const ticketDetail = vi.fn().mockImplementation(async () => ({
      ok: true,
      value: {
        ticket: ticketOf({ id: 'ticket-ext', title: 'Run external CLI', state: running ? 'running' : 'ended' }),
        dispatches: [{
          id: 'disp-1',
          ticketId: 'ticket-ext',
          state: running ? 'running' : 'ended',
          ...(running ? {} : { outcome: 'interrupted' }),
          agentKind: 'claude-code',
          reports: [
            {
              id: 'r-1',
              kind: 'progress',
              message: '[claude-code] tool: Bash: pnpm test',
              activity: { category: 'command', toolName: 'Bash', target: 'pnpm test' },
              at: 10,
            },
          ],
          createdAt: 1,
          updatedAt: 10,
        }],
        deliverables: [],
        changes: [],
        followUps: [],
      },
    }))
    const dispatchCancel = vi.fn().mockImplementation(async () => {
      running = false
      return { ok: true, value: { cancelled: true, dispatch: { id: 'disp-1', ticketId: 'ticket-ext', state: 'ended', outcome: 'interrupted', reports: [], createdAt: 1, updatedAt: 20 } } }
    })
    const ticketWorktree = vi.fn().mockImplementation(async () => ({
      ok: true,
      value: {
        worktree: {
          exists: worktreeExists,
          path: '/repo/.dsh-worktrees/ticket-ext',
          branch: 'dsh-manager/ticket-ext',
          dirtyFiles: worktreeExists ? ['M src/app.ts'] : [],
          stat: ' src/app.ts | 2 +-',
          diff: '+console.log("ok")',
          truncated: false,
        },
      },
    }))
    const ticketWorktreeRemove = vi.fn().mockImplementation(async () => {
      worktreeExists = false
      return { ok: true, value: { removed: true } }
    })

    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ running: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-ext', title: 'Run external CLI', state: 'running' })] },
      }),
      { ticketDetail, dispatchCancel, ticketWorktree, ticketWorktreeRemove },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Run external CLI')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Bash · pnpm test')
      expect(view.container.textContent).toContain('tool calls')
      expect(view.container.textContent).toContain('dsh-manager/ticket-ext')
    })

    // Worktree controls live under the ticket info disclosure.
    openInfo()
    // Show unified worktree diff inline.
    fireEvent.click(view.view.getByRole('button', { name: 'Show diff' }))
    expect(view.container.textContent).toContain('+console.log("ok")')

    // Worktree remove is disabled while dispatch is still running; cancel it first.
    const removeBtn = view.view.getByRole('button', { name: 'Remove worktree' }) as HTMLButtonElement
    expect(removeBtn.disabled).toBe(true)
    fireEvent.click(view.view.getByRole('button', { name: 'Cancel turn' }))
    await vi.waitFor(() => {
      expect(dispatchCancel).toHaveBeenCalledWith({ dispatchId: 'disp-1' })
      expect(view.container.textContent).toContain('Interrupted')
    })
    await vi.waitFor(() => {
      expect((view.view.getByRole('button', { name: 'Remove worktree' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Remove worktree' }))
    await vi.waitFor(() => {
      expect(ticketWorktreeRemove).toHaveBeenCalledWith({ ticketId: 'ticket-ext' })
      expect(view.container.textContent).toContain('No worktree present for this ticket.')
    })
    await runtime.dispose()
  })

  test('renders builtin session assistant replies, live status badge, and updates on refresh', async () => {
    let callCount = 0
    const ticketDetail = vi.fn().mockImplementation(async () => {
      callCount += 1
      return {
        ok: true,
        value: {
          ticket: ticketOf({ id: 'ticket-builtin', title: 'Inspect builtin turn', state: 'running' }),
          dispatches: [{
            id: 'disp-builtin',
            ticketId: 'ticket-builtin',
            state: 'running',
            sessionId: 'dsh-manager-exec-disp-builtin',
            reports: [],
            messages: [
              { id: 'session-tool-1', role: 'tool', toolName: 'fs_read', category: 'file', text: 'fs_read: src/index.ts', at: 10 },
              { id: 'session-msg-2', role: 'assistant', text: callCount === 1 ? '### Key Findings\n\nFirst interim reply with `src/index.ts`' : 'Updated reply after refresh', at: 20 },
            ],
            createdAt: 1,
            updatedAt: 20,
          }],
          deliverables: [],
          changes: [],
          followUps: [],
        },
      }
    })

    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ running: 1 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-builtin', title: 'Inspect builtin turn', state: 'running' })] },
      }),
      { ticketDetail },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Inspect builtin turn')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Live')
      expect(view.container.textContent).toContain('Built-in executor')
      expect(view.container.textContent).toContain('dsh-manager-exec-disp-builtin')
      expect(view.container.textContent).toContain('First interim reply')
      expect(dialogEl().textContent).toContain('Dispatch history')
      expect(document.body.textContent).toContain('Key Findings')
    })

    fireEvent.click(view.view.getByRole('button', { name: 'Refresh' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Updated reply after refresh')
    })
    await runtime.dispose()
  })

  test('hides resolved-thread failed evals from rework pool and exposes Re-dispatch button on todo tickets', async () => {
    const dispatchTicket = vi.fn().mockResolvedValue({ ok: true, value: { id: 'disp-new', ticketId: 'ticket-todo', state: 'queued', reports: [], createdAt: 2, updatedAt: 2 } })
    const evalList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        evals: [
          {
            id: 'eval-old-fail',
            threadId: 'thr-1',
            triggerIds: ['trg-1'],
            status: 'failed',
            startedAt: 1,
            finishedAt: 2,
            triggers: [{ id: 'trg-1', externalKey: 'BUG-1', summary: 'old fail' }],
          },
          {
            id: 'eval-accepted',
            threadId: 'thr-1',
            triggerIds: ['trg-1'],
            status: 'accepted',
            startedAt: 3,
            finishedAt: 4,
            ticketId: 'ticket-todo',
            triggers: [{ id: 'trg-1', externalKey: 'BUG-1', summary: 'accepted' }],
          },
        ],
      },
    })
    const ticketDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: ticketOf({ id: 'ticket-todo', title: 'Retry failed dispatch', state: 'todo', threadId: 'thr-1' }),
        dispatches: [{
          id: 'disp-failed',
          ticketId: 'ticket-todo',
          state: 'ended',
          outcome: 'failed',
          agentKind: 'agy',
          reports: [{ id: 'r-err', kind: 'failed', message: 'prior cli error', at: 5 }],
          createdAt: 4,
          updatedAt: 5,
        }],
        deliverables: [],
        changes: [],
        followUps: [],
      },
    })

    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1, pool: 0 }) }),
      vi.fn().mockResolvedValue({
        ok: true,
        value: { tickets: [ticketOf({ id: 'ticket-todo', title: 'Retry failed dispatch', state: 'todo', threadId: 'thr-1' })] },
      }),
      { evalList, ticketDetail, dispatchTicket },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Retry failed dispatch')
    })
    // Stale failed eval sharing thr-1 is suppressed from the pool column.
    expect(view.container.querySelectorAll('li[data-state="pool"]')).toHaveLength(0)

    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('prior cli error')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Re-dispatch' }))
    await vi.waitFor(() => {
      expect(dispatchTicket).toHaveBeenCalledWith({ ticketId: 'ticket-todo' })
    })
    await runtime.dispose()
  })

  test('renders waiting badge on todo cards and allows unblocking prerequisites from TicketDetail', async () => {
    const setTicketDependencies = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: ticketOf({ id: 'ticket-blocked', title: 'Add desktop notify', state: 'todo' }),
      },
    })
    const blockedTicket = ticketOf({
      id: 'ticket-blocked',
      title: 'Add desktop notify',
      state: 'todo',
      dependsOn: ['ticket-prereq'],
      waitingOn: [{ id: 'ticket-prereq', title: 'Clean up legacy tabs', state: 'running' }],
    })
    const ticketDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: blockedTicket,
        dispatches: [],
        deliverables: [],
        changes: [],
        followUps: [],
      },
    })

    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ todo: 1 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [blockedTicket] } }),
      { ticketDetail, setTicketDependencies },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Add desktop notify')
      expect(view.container.textContent).toContain('Waiting on 1')
    })

    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('Prerequisites')
      expect(dialogEl().textContent).toContain('Clean up legacy tabs')
    })
    openInfo()
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Unblock / Run in parallel' }))
    await vi.waitFor(() => {
      expect(setTicketDependencies).toHaveBeenCalledWith({ ticketId: 'ticket-blocked', dependsOn: [] })
    })
    await runtime.dispose()
  })

  test('supports two-step manual ticket closing in TicketDetail and quick buttons for Steward confirmations', async () => {
    const closeTicket = vi.fn().mockResolvedValue({
      ok: true,
      value: { ticket: ticketOf({ id: 'ticket-open', title: 'Abandonable work', state: 'ended' }) },
    })
    const answerAttention = vi.fn().mockResolvedValue({ ok: true, value: { id: 'att-skip', status: 'answered' } })
    const openTicket = ticketOf({ id: 'ticket-open', title: 'Abandonable work', state: 'attention' })
    const ticketDetail = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ticket: openTicket,
        dispatches: [],
        deliverables: [],
        changes: [],
        followUps: [],
      },
    })
    const attentionList = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        attentions: [
          {
            id: 'att-skip',
            ticketId: 'ticket-open',
            dispatchId: 'steward',
            kind: 'question',
            question: '[skip] skip stage 1/3 of "Dev" for ticket ticket-open?',
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'att-route',
            ticketId: 'ticket-open',
            dispatchId: 'steward',
            kind: 'question',
            question: 'no configured route fits ticket ticket-open',
            status: 'pending',
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      },
    })

    const { runtime, view } = await mountBoard(
      vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ attention: 1 }) }),
      vi.fn().mockResolvedValue({ ok: true, value: { tickets: [openTicket] } }),
      { ticketDetail, closeTicket, attentionList, answerAttention },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Confirm skip')
      expect(view.container.textContent).toContain('Dispatch once')
    })

    fireEvent.click(view.view.getAllByRole('button', { name: 'Confirm skip' })[0]!)
    await vi.waitFor(() => {
      expect(answerAttention).toHaveBeenCalledWith({ attentionId: 'att-skip', answer: 'confirmed' })
    })

    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('Ticket info')
    })
    openInfo()
    await vi.waitFor(() => {
      expect(within(dialogEl()).getByRole('button', { name: 'Close ticket' })).toBeDefined()
    })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Close ticket' }))
    await vi.waitFor(() => {
      expect(within(dialogEl()).getByRole('button', { name: 'Confirm close?' })).toBeDefined()
    })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Confirm close?' }))
    await vi.waitFor(() => {
      expect(closeTicket).toHaveBeenCalledWith({ ticketId: 'ticket-open' })
    })
    await runtime.dispose()
  })
})
