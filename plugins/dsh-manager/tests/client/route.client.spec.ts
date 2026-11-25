// @vitest-environment jsdom
/** Slot-tier specs for the team page's route-rule section and mindmap against a scripted Remote namespace. */
import { fireEvent, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { CrewMemberView } from '../../src/crew/wire-types.ts'
import type { PipelineView } from '../../src/pipeline/wire-types.ts'
import type { RouteRuleView } from '../../src/route/wire-types.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'

/** The open modal, portal-mounted on document.body; queries must scope here. */
function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) throw new Error('the dialog is not open')
  return el
}

function memberOf(id: string, name: string): CrewMemberView {
  return { id, name, role: `role of ${name}`, enabled: true, createdAt: 1, updatedAt: 1 }
}

function pipelineOf(id: string, name: string): PipelineView {
  return {
    id,
    name,
    stages: [
      { memberId: 'a', instruction: 'draft the note', skippable: false },
      { memberId: 'b', instruction: '', skippable: true, skipLogic: 'doc-only change' },
    ],
    createdAt: 1,
    updatedAt: 1,
  }
}

function ruleOf(id: string, overrides: Partial<RouteRuleView> = {}): RouteRuleView {
  return {
    id,
    condition: 'dev work that changes code',
    pipelineId: 'p1',
    enabled: true,
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** Mount the team page against a runtime whose Remote reads are scripted. */
async function mountTeam(overrides: {
  crewList?: ReturnType<typeof vi.fn>
  pipelineList?: ReturnType<typeof vi.fn>
  ruleList?: ReturnType<typeof vi.fn>
  ruleAdd?: ReturnType<typeof vi.fn>
  ruleUpdate?: ReturnType<typeof vi.fn>
  ruleRemove?: ReturnType<typeof vi.fn>
} = {}): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      crewList: overrides.crewList ?? vi.fn().mockResolvedValue({ ok: true, value: { members: [memberOf('a', 'Product Wang'), memberOf('b', 'Dev Li')] } }),
      crewAdd: vi.fn().mockResolvedValue({ ok: false }),
      crewUpdate: vi.fn().mockResolvedValue({ ok: false }),
      crewRemove: vi.fn().mockResolvedValue({ ok: true }),
      pipelineList: overrides.pipelineList ?? vi.fn().mockResolvedValue({ ok: true, value: { pipelines: [pipelineOf('p1', 'Dev line')] } }),
      pipelineAdd: vi.fn().mockResolvedValue({ ok: false }),
      pipelineUpdate: vi.fn().mockResolvedValue({ ok: false }),
      pipelineRemove: vi.fn().mockResolvedValue({ ok: true }),
      pipelineReferencesOf: vi.fn().mockResolvedValue({ ok: true, value: { references: [] } }),
      ruleList: overrides.ruleList ?? vi.fn().mockResolvedValue({ ok: true, value: { rules: [] } }),
      ruleAdd: overrides.ruleAdd ?? vi.fn().mockResolvedValue({ ok: false }),
      ruleUpdate: overrides.ruleUpdate ?? vi.fn().mockResolvedValue({ ok: false }),
      ruleRemove: overrides.ruleRemove ?? vi.fn().mockResolvedValue({ ok: true }),
      ruleReferencesOfPipeline: vi.fn().mockResolvedValue({ ok: true, value: { rules: [] } }),
      stewardStatus: vi.fn().mockResolvedValue({ ok: true, value: { busy: false, backlog: 0, mode: 'auto', activity: [] } }),
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  // The single tabbed panel defaults to the board; open the team tab (defaults to Workbench -> Topology).
  fireEvent.click(view.view.getByRole('tab', { name: 'Team' }))
  return { runtime, view }
}

describe('team page route rules', () => {
  test('renders one card per rule with its condition and target pipeline in List mode', async () => {
    const { runtime, view } = await mountTeam({
      ruleList: vi.fn().mockResolvedValue({ ok: true, value: { rules: [ruleOf('r1')] } }),
    })
    fireEvent.click(view.view.getByRole('tab', { name: 'List' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('dev work that changes code')
    })
    expect(view.container.textContent).toContain('Dev line')
    expect(view.container.textContent).toContain('Route rules')
    await runtime.dispose()
  })

  test('the add modal submits a condition and pipeline even when topology has no rules yet', async () => {
    const ruleAdd = vi.fn().mockResolvedValue({ ok: true, value: { rule: ruleOf('new') } })
    const { runtime, view } = await mountTeam({ ruleAdd })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Rule map')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add rule' }))
    const dialog = dialogEl()
    fireEvent.change(within(dialog).getByPlaceholderText(/Describe in natural language/), { target: { value: 'doc-only changes' } })
    const trigger = [...dialog.querySelectorAll<HTMLElement>('[data-select-control]')][0]!
    fireEvent.click(trigger)
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'Dev line')!)
    const submit = () => within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    await vi.waitFor(() => {
      expect(submit().disabled).toBe(false)
    })
    fireEvent.click(submit())
    await vi.waitFor(() => {
      expect(ruleAdd).toHaveBeenCalledWith({ condition: 'doc-only changes', pipelineId: 'p1' })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    await runtime.dispose()
  })

  test('the mindmap draws the enabled rules as branches with their stage chains', async () => {
    const { runtime, view } = await mountTeam({
      ruleList: vi.fn().mockResolvedValue({
        ok: true,
        value: { rules: [ruleOf('r1'), ruleOf('r2', { condition: 'disabled rule', enabled: false })] },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Rule map')
    })
    expect(view.container.textContent).toContain('Ticket received')
    // The enabled rule's branch shows the condition, the pipeline, and the stage chain.
    expect(view.container.textContent).toContain('dev work that changes code')
    expect(view.container.textContent).toContain('Dev line')
    expect(view.container.textContent).toContain('Product Wang')
    expect(view.container.textContent).toContain('Dev Li')
    // The disabled rule stays off the map (the list card keeps showing it).
    const mindmap = view.container.querySelector('section[aria-label="Rule map"]')
    expect(mindmap).not.toBeNull()
    expect(mindmap!.textContent).not.toContain('disabled rule')
    await runtime.dispose()
  })

  test('topology inspector edits, disables, and removes a selected rule', async () => {
    const ruleUpdate = vi.fn().mockResolvedValue({ ok: true, value: { rule: ruleOf('r1', { condition: 'updated condition' }) } })
    const ruleRemove = vi.fn().mockResolvedValue({ ok: true, value: { removed: true } })
    const { runtime, view } = await mountTeam({
      ruleList: vi.fn().mockResolvedValue({ ok: true, value: { rules: [ruleOf('r1')] } }),
      ruleUpdate,
      ruleRemove,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('dev work that changes code')
    })
    const inspector = view.container.querySelector('aside[aria-label="Node inspector"]') as HTMLElement
    expect(inspector).not.toBeNull()
    // Select the rule node via the index item.
    fireEvent.click(within(inspector).getByRole('button', { name: 'dev work that changes code' }))
    // Edit rule via Inspector.
    fireEvent.click(within(inspector).getByRole('button', { name: 'Edit' }))
    const dialog = dialogEl()
    fireEvent.change(within(dialog).getByPlaceholderText(/Describe in natural language/), { target: { value: 'updated condition' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => {
      expect(ruleUpdate).toHaveBeenCalledWith({ ruleId: 'r1', condition: 'updated condition', pipelineId: 'p1' })
      expect((within(inspector).getByRole('button', { name: 'Disable' }) as HTMLButtonElement).disabled).toBe(false)
    })
    // Disable rule via Inspector: clears selection cleanly without crashing.
    fireEvent.click(within(inspector).getByRole('button', { name: 'Disable' }))
    await vi.waitFor(() => {
      expect(ruleUpdate).toHaveBeenCalledWith({ ruleId: 'r1', enabled: false })
    })
    // Re-select rule via node index and wait until busy clears, then Remove.
    fireEvent.click(within(inspector).getByRole('button', { name: 'dev work that changes code' }))
    await vi.waitFor(() => {
      expect((within(inspector).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(within(inspector).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(ruleRemove).toHaveBeenCalledWith({ ruleId: 'r1' })
    })
    await runtime.dispose()
  })

  test('topology inspector supports pipeline Add rule, Stage Edit pipeline, and 2-step pipeline remove', async () => {
    const pipelineRemove = vi.fn().mockResolvedValue({ ok: true, value: { removed: true } })
    const ruleReferencesOfPipeline = vi.fn().mockResolvedValue({ ok: true, value: { rules: ['dev work that changes code'] } })
    const ruleAdd = vi.fn().mockResolvedValue({ ok: true, value: { rule: ruleOf('r2') } })
    const runtime = await SlotTestRuntime.create()
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.ctx.slots.installLocale(locale)
    await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
    runtime.remote.provideNamespaces({
      dshManager: {
        crewList: vi.fn().mockResolvedValue({ ok: true, value: { members: [memberOf('a', 'Product Wang')] } }),
        crewAdd: vi.fn().mockResolvedValue({ ok: false }),
        crewUpdate: vi.fn().mockResolvedValue({ ok: false }),
        crewRemove: vi.fn().mockResolvedValue({ ok: true }),
        pipelineList: vi.fn().mockResolvedValue({ ok: true, value: { pipelines: [pipelineOf('p1', 'Dev line')] } }),
        pipelineAdd: vi.fn().mockResolvedValue({ ok: false }),
        pipelineUpdate: vi.fn().mockResolvedValue({ ok: false }),
        pipelineRemove,
        pipelineReferencesOf: vi.fn().mockResolvedValue({ ok: true, value: { references: [] } }),
        ruleList: vi.fn().mockResolvedValue({ ok: true, value: { rules: [ruleOf('r1')] } }),
        ruleAdd,
        ruleUpdate: vi.fn().mockResolvedValue({ ok: false }),
        ruleRemove: vi.fn().mockResolvedValue({ ok: true }),
        ruleReferencesOfPipeline,
        stewardStatus: vi.fn().mockResolvedValue({ ok: true, value: { busy: false, backlog: 0, mode: 'auto', activity: [] } }),
      },
    })
    await runtime.mount({ inject: UI_INJECT, apply: registerUi })
    const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
    fireEvent.click(view.view.getByRole('tab', { name: 'Team' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Dev line')
    })
    const inspector = view.container.querySelector('aside[aria-label="Node inspector"]') as HTMLElement
    // 1. Select Stage node -> Edit pipeline opens prefilled Pipeline modal.
    fireEvent.click(within(inspector).getByRole('button', { name: /1\. Product Wang/ }))
    fireEvent.click(within(inspector).getByRole('button', { name: 'Edit pipeline' }))
    expect((within(dialogEl()).getByPlaceholderText('e.g. Dev line') as HTMLInputElement).value).toBe('Dev line')
    fireEvent.click(within(dialogEl()).getAllByRole('button', { name: 'Cancel' }).at(-1)!)

    // 2. Select Pipeline node -> Add rule prefills pipelineId p1.
    fireEvent.click(within(inspector).getByRole('button', { name: 'Dev line' }))
    fireEvent.click(within(inspector).getByRole('button', { name: 'Add rule' }))
    const ruleDialog = dialogEl()
    fireEvent.change(within(ruleDialog).getByPlaceholderText(/Describe in natural language/), { target: { value: 'another rule' } })
    fireEvent.click(within(ruleDialog).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(ruleAdd).toHaveBeenCalledWith({ condition: 'another rule', pipelineId: 'p1' })
    })

    // 3. Two-step remove from Inspector checks ruleReferencesOfPipeline first.
    fireEvent.click(within(inspector).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(inspector.textContent).toContain('dev work that changes code')
    })
    expect(pipelineRemove).not.toHaveBeenCalled()
    await new Promise(resolve => { setTimeout(resolve, 30) })
    fireEvent.click(within(inspector).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(pipelineRemove).toHaveBeenCalledWith({ pipelineId: 'p1' })
    })
    await runtime.dispose()
  })
})
