// @vitest-environment jsdom
/** Slot-tier specs for the team page's pipeline section against a scripted Remote namespace. */
import { fireEvent, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { CrewMemberView } from '../../src/crew/wire-types.ts'
import type { PipelineView } from '../../src/pipeline/wire-types.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'

/** The open modal, portal-mounted on document.body; queries must scope here. */
function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) throw new Error('the dialog is not open')
  return el
}

/** The card whose text contains the needle; crew and pipeline cards share the button names. */
function cardOf(container: HTMLElement, needle: string): HTMLElement {
  const card = [...container.querySelectorAll('li')].find(li => li.textContent?.includes(needle))
  if (!(card instanceof HTMLElement)) throw new Error(`card not found: ${needle}`)
  return card
}

function memberOf(id: string, name: string): CrewMemberView {
  return { id, name, role: `role of ${name}`, enabled: true, createdAt: 1, updatedAt: 1 }
}

function pipelineOf(id: string, overrides: Partial<PipelineView> = {}): PipelineView {
  return {
    id,
    name: `pipe-${id}`,
    stages: [{ memberId: 'a', instruction: 'draft the note', skippable: false }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** Mount the team page against a runtime whose Remote reads are scripted. */
async function mountTeam(overrides: {
  crewList?: ReturnType<typeof vi.fn>
  crewRemove?: ReturnType<typeof vi.fn>
  pipelineList?: ReturnType<typeof vi.fn>
  pipelineAdd?: ReturnType<typeof vi.fn>
  pipelineUpdate?: ReturnType<typeof vi.fn>
  pipelineRemove?: ReturnType<typeof vi.fn>
  pipelineReferencesOf?: ReturnType<typeof vi.fn>
} = {}): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      crewList: overrides.crewList ?? vi.fn().mockResolvedValue({ ok: true, value: { members: [memberOf('a', 'Product Wang')] } }),
      crewAdd: vi.fn().mockResolvedValue({ ok: false }),
      crewUpdate: vi.fn().mockResolvedValue({ ok: false }),
      crewRemove: overrides.crewRemove ?? vi.fn().mockResolvedValue({ ok: true }),
      pipelineList: overrides.pipelineList ?? vi.fn().mockResolvedValue({ ok: true, value: { pipelines: [] } }),
      pipelineAdd: overrides.pipelineAdd ?? vi.fn().mockResolvedValue({ ok: false }),
      pipelineUpdate: overrides.pipelineUpdate ?? vi.fn().mockResolvedValue({ ok: false }),
      pipelineRemove: overrides.pipelineRemove ?? vi.fn().mockResolvedValue({ ok: true }),
      pipelineReferencesOf: overrides.pipelineReferencesOf ?? vi.fn().mockResolvedValue({ ok: true, value: { references: [] } }),
      stewardStatus: vi.fn().mockResolvedValue({ ok: true, value: { busy: false, backlog: 0, mode: 'auto', activity: [] } }),
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  // The single tabbed panel defaults to the board; open Team -> Workbench (List view).
  fireEvent.click(view.view.getByRole('tab', { name: 'Team' }))
  fireEvent.click(view.view.getByRole('tab', { name: 'List' }))
  return { runtime, view }
}

describe('team page pipeline section', () => {
  test('renders one card per pipeline with its ordered stage members', async () => {
    const { runtime, view } = await mountTeam({
      pipelineList: vi.fn().mockResolvedValue({
        ok: true,
        value: { pipelines: [pipelineOf('p1', { name: 'Dev line', stages: [{ memberId: 'a', instruction: 'draft', skippable: false }] })] },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Dev line')
    })
    expect(view.container.textContent).toContain('Product Wang')
    expect(view.container.textContent).toContain('draft')
    expect(view.container.textContent).toContain('1 stage')
    await runtime.dispose()
  })

  test('the add modal composes stages and submits; a stage without a member blocks the submit', async () => {
    const pipelineAdd = vi.fn().mockResolvedValue({ ok: true, value: { pipeline: pipelineOf('new') } })
    const { runtime, view } = await mountTeam({ pipelineAdd })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Pipelines')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add pipeline' }))
    const dialog = dialogEl()
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Dev line'), { target: { value: 'Test line' } })
    // The default first stage has no member yet; the submit stays blocked.
    const submit = () => within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(submit().disabled).toBe(true)
    // Choose the member on the first stage's selector.
    const memberTrigger = dialog.querySelectorAll<HTMLElement>('[data-select-control]')[0]!
    fireEvent.click(memberTrigger)
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'Product Wang')!)
    await vi.waitFor(() => {
      expect(submit().disabled).toBe(false)
    })
    fireEvent.click(submit())
    await vi.waitFor(() => {
      expect(pipelineAdd).toHaveBeenCalledWith({ name: 'Test line', stages: [{ memberId: 'a', skippable: false }] })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    await runtime.dispose()
  })

  test('a skippable stage reveals the skip-logic field and carries it in the submit', async () => {
    const pipelineAdd = vi.fn().mockResolvedValue({ ok: true, value: { pipeline: pipelineOf('new') } })
    const { runtime, view } = await mountTeam({ pipelineAdd })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Pipelines')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add pipeline' }))
    const dialog = dialogEl()
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Dev line'), { target: { value: 'Test line' } })
    // Enable skippable on the first stage; the skip-logic field appears.
    expect(within(dialog).queryByPlaceholderText(/steward may skip/)).toBeNull()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    const skipLogic = within(dialog).getByPlaceholderText(/steward may skip/)
    fireEvent.change(skipLogic, { target: { value: 'skip for doc-only changes' } })
    const memberTrigger = dialog.querySelectorAll<HTMLElement>('[data-select-control]')[0]!
    fireEvent.click(memberTrigger)
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'Product Wang')!)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(pipelineAdd).toHaveBeenCalledWith({
        name: 'Test line',
        stages: [{ memberId: 'a', skippable: true, skipLogic: 'skip for doc-only changes' }],
      })
    })
    await runtime.dispose()
  })

  test('the edit modal pre-fills the stored stages and submits an update', async () => {
    const pipelineUpdate = vi.fn().mockResolvedValue({ ok: true, value: { pipeline: pipelineOf('p1') } })
    const { runtime, view } = await mountTeam({
      pipelineList: vi.fn().mockResolvedValue({
        ok: true,
        value: { pipelines: [pipelineOf('p1', { name: 'Dev line' })] },
      }),
      pipelineUpdate,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Dev line')
    })
    fireEvent.click(within(cardOf(view.container, 'Dev line')).getByRole('button', { name: 'Edit' }))
    const dialog = dialogEl()
    expect((within(dialog).getByPlaceholderText('e.g. Dev line') as HTMLInputElement).value).toBe('Dev line')
    // The stored stage's member selector carries the reference.
    const memberTriggers = [...dialog.querySelectorAll<HTMLElement>('[data-select-control]')]
    expect(memberTriggers[0]!.getAttribute('data-value')).toBe('a')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => {
      expect(pipelineUpdate).toHaveBeenCalledWith({
        pipelineId: 'p1',
        name: 'Dev line',
        stages: [{ memberId: 'a', instruction: 'draft the note', skippable: false }],
      })
    })
    await runtime.dispose()
  })

  test('removing a crew member referenced by a pipeline shows the references first', async () => {
    const crewRemove = vi.fn().mockResolvedValue({ ok: true, value: { removed: true } })
    const pipelineReferencesOf = vi.fn().mockResolvedValue({ ok: true, value: { references: ['Dev line (stage 1)'] } })
    const { runtime, view } = await mountTeam({
      crewList: vi.fn().mockResolvedValue({ ok: true, value: { members: [memberOf('a', 'Product Wang')] } }),
      pipelineList: vi.fn().mockResolvedValue({
        ok: true,
        value: { pipelines: [pipelineOf('p1', { name: 'Dev line' })] },
      }),
      pipelineReferencesOf,
      crewRemove,
    })
    fireEvent.click(view.view.getByRole('tab', { name: 'Crew roster' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Product Wang')
    })
    // The first click shows the reference warning; nothing is removed yet.
    fireEvent.click(within(cardOf(view.container, 'Product Wang')).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Dev line (stage 1)')
    })
    expect(crewRemove).not.toHaveBeenCalled()
    // The warning's re-render must commit before the confirming click lands
    // on the same button.
    await new Promise(resolve => { setTimeout(resolve, 50) })
    const card = cardOf(view.container, 'Product Wang')
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(crewRemove).toHaveBeenCalledWith({ memberId: 'a' })
    })
    console.log('refsOf calls after both clicks:', pipelineReferencesOf.mock.calls.length)
    await runtime.dispose()
  })
})
