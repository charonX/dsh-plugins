// @vitest-environment jsdom
/** Slot-tier specs for the flow views: the card badge and the detail timeline. */
import { fireEvent } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { BoardSummary, TicketView } from '../../src/index.ts'
import type { TicketDetailView } from '../../src/dispatch/wire-types.ts'
import type { FlowTimelineView } from '../../src/flow/flow-core.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'

/** The open modal, portal-mounted on document.body; queries must scope here. */
function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) throw new Error('the dialog is not open')
  return el
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

const timelineOf: FlowTimelineView = {
  rootTicketId: 'ticket-1',
  pipelineId: 'pipe-1',
  pipelineName: 'Test line',
  stageCount: 3,
  stages: [
    { ticketId: 'ticket-1', title: 'Accepted work', state: 'ended', stageIndex: 0, memberName: 'Designer', readyReport: 'very long markdown result that should stay out of sidebar' },
    { ticketId: 'ticket-2', title: 'final check', state: 'running', stageIndex: 2, memberName: 'Reviewer', deliverables: ['stage-note.md'] },
  ],
  skipped: [{ stageIndex: 1, reason: 'docs not needed' }],
}

const detailOf: TicketDetailView = {
  ticket: ticketOf({
    id: 'ticket-1',
    title: 'Accepted work',
    state: 'ended',
    projectId: 'proj-uuid-1234',
    projectName: 'home-repos',
    sourceConnectionId: 'conn-uuid-9999',
    sourceConnectionName: 'Company GitLab',
    flow: { pipelineId: 'pipe-1', pipelineName: 'Test line', stageIndex: 0, stageCount: 3 },
  }),
  dispatches: [{
    id: 'disp-1',
    ticketId: 'ticket-1',
    state: 'ended',
    outcome: 'ready',
    sessionId: 'sess-uuid-1111',
    externalSessionId: 'ext-uuid-2222',
    sessionTitle: 'Designer',
    reports: [],
    createdAt: 1,
    updatedAt: 2,
  }],
  deliverables: [],
  changes: [],
  followUps: [],
}

/** Mount the board UI against a runtime whose Remote reads are scripted. */
async function mountBoard(extras: {
  ticketList?: ReturnType<typeof vi.fn>
  ticketDetail?: ReturnType<typeof vi.fn>
  flowTimeline?: ReturnType<typeof vi.fn>
} = {}): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('uiWorkspace', { openSession: () => {} })
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      summary: vi.fn().mockResolvedValue({ ok: true, value: summaryOf({ ended: 1 }) }),
      ticketList: extras.ticketList ?? vi.fn().mockResolvedValue({ ok: true, value: { tickets: [detailOf.ticket] } }),
      candidateList: vi.fn().mockResolvedValue({ ok: true, value: { candidates: [] } }),
      acceptCandidate: vi.fn().mockResolvedValue({ ok: true }),
      evalList: vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } }),
      evalRequeue: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      manualInput: vi.fn().mockResolvedValue({ ok: true, value: { threadId: 'thr-manual' } }),
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
      projectList: vi.fn().mockResolvedValue({ ok: true, value: { projects: [] } }),
      ticketDetail: extras.ticketDetail ?? vi.fn().mockResolvedValue({ ok: true, value: detailOf }),
      ticketChangeDiff: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      flowTimeline: extras.flowTimeline ?? vi.fn().mockResolvedValue({ ok: true, value: timelineOf }),
      attentionList: vi.fn().mockResolvedValue({ ok: true, value: { attentions: [] } }),
      answerAttention: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'unused' } }),
      notificationList: vi.fn().mockResolvedValue({ ok: true, value: { notifications: [] } }),
    },
  })
  await runtime.mount({ inject: [...UI_INJECT, 'uiWorkspace'], apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  return { runtime, view }
}

describe('flow views', () => {
  test('a routed ticket card carries the pipeline-stage badge', async () => {
    const { runtime, view } = await mountBoard()
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Accepted work')
    })
    expect(view.container.textContent).toContain('Test line · stage 1/3')
    await runtime.dispose()
  })

  test('an unrouted card carries no badge', async () => {
    const plain = ticketOf({ id: 'ticket-1', title: 'Accepted work', state: 'ended' })
    const { runtime, view } = await mountBoard({ ticketList: vi.fn().mockResolvedValue({ ok: true, value: { tickets: [plain] } }) })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Accepted work')
    })
    expect(view.container.textContent).not.toContain('Test line · stage')
    await runtime.dispose()
  })

  test('the detail timeline shows concise stage steps without dumping readyReport, and properties show names over UUIDs', async () => {
    const { runtime, view } = await mountBoard()
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Accepted work')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('Pipeline: Test line')
    })
    const dialog = dialogEl()
    expect(dialog.textContent).toContain('Stage 1/3')
    expect(dialog.textContent).toContain('Stage 3/3')
    expect(dialog.textContent).toContain('Designer')
    expect(dialog.textContent).toContain('Reviewer')
    expect(dialog.textContent).not.toContain('very long markdown result that should stay out of sidebar')
    expect(dialog.textContent).toContain('Skipped stages')
    expect(dialog.textContent).toContain('Stage 2: docs not needed')
    expect(dialog.textContent).toContain('stage-note.md')
    expect(dialog.textContent).toContain('home-repos')
    expect(dialog.textContent).toContain('Company GitLab')
    const propsSection = Array.from(dialog.querySelectorAll('section'))
      .find(section => section.textContent?.includes('Properties'))
    expect(propsSection?.textContent).toContain('home-repos')
    expect(propsSection?.textContent).toContain('Company GitLab')
    expect(propsSection?.textContent).not.toContain('proj-uuid-1234')
    expect(propsSection?.textContent).not.toContain('conn-uuid-9999')
    fireEvent.click(dialog.querySelector('button[aria-label="Close"]')!)
    await runtime.dispose()
  })

  test('a ticket that walks no pipeline shows no timeline section', async () => {
    const { runtime, view } = await mountBoard({
      flowTimeline: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Accepted work')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Detail' }))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('Dispatch history')
    })
    expect(dialogEl().textContent).not.toContain('Pipeline: Test line')
    await runtime.dispose()
  })
})
