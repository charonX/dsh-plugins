// @vitest-environment jsdom
/** Slot-tier specs for the team page's crew section against a scripted Remote namespace. */
import { fireEvent, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { CrewMemberView } from '../../src/crew/wire-types.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'

/** The open modal, portal-mounted on document.body; queries must scope here. */
function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) throw new Error('the dialog is not open')
  return el
}

function memberOf(id: string, overrides: Partial<CrewMemberView> = {}): CrewMemberView {
  return {
    id,
    name: `member-${id}`,
    role: 'owns the requirement draft',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** Let a click's in-flight publish/refresh cycle (busy → re-read → publish) flush before the next interaction. */
async function settle(): Promise<void> {
  await new Promise(resolve => { setTimeout(resolve, 50) })
}

async function mountTeam(crewList: ReturnType<typeof vi.fn>, extra: {
  crewAdd?: ReturnType<typeof vi.fn>
  crewUpdate?: ReturnType<typeof vi.fn>
  crewRemove?: ReturnType<typeof vi.fn>
  modelOptions?: ReturnType<typeof vi.fn>
  agentKindOptions?: ReturnType<typeof vi.fn>
} = {}): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      crewList,
      modelOptions: extra.modelOptions ?? vi.fn().mockResolvedValue({ ok: true, value: { providers: [] } }),
      agentKindOptions: extra.agentKindOptions ?? vi.fn().mockResolvedValue({
        ok: true,
        value: {
          kinds: [
            { kind: 'builtin', command: '', available: true },
            { kind: 'claude-code', command: 'claude', available: true, executablePath: '/Users/dev/.local/bin/claude', version: '2.1.12' },
            { kind: 'codex', command: 'codex', available: false, reason: 'not found' },
            { kind: 'agy', command: 'agy', available: true, executablePath: '/Users/dev/.local/bin/agy', version: '0.9.4' },
          ],
        },
      }),
      crewAdd: extra.crewAdd ?? vi.fn().mockResolvedValue({ ok: false }),
      crewUpdate: extra.crewUpdate ?? vi.fn().mockResolvedValue({ ok: false }),
      crewRemove: extra.crewRemove ?? vi.fn().mockResolvedValue({ ok: true }),
      pipelineList: vi.fn().mockResolvedValue({ ok: true, value: { pipelines: [] } }),
      pipelineAdd: vi.fn().mockResolvedValue({ ok: false }),
      pipelineUpdate: vi.fn().mockResolvedValue({ ok: false }),
      pipelineRemove: vi.fn().mockResolvedValue({ ok: true }),
      pipelineReferencesOf: vi.fn().mockResolvedValue({ ok: true, value: { references: [] } }),
      stewardStatus: vi.fn().mockResolvedValue({ ok: true, value: { busy: false, backlog: 0, mode: 'auto', activity: [] } }),
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  // The single tabbed panel defaults to the board; open the team tab and switch to Crew roster.
  fireEvent.click(view.view.getByRole('tab', { name: 'Team' }))
  fireEvent.click(view.view.getByRole('tab', { name: 'Crew roster' }))
  return { runtime, view }
}

describe('team page crew section', () => {
  test('Team tab excludes runtime steward/eval audit sections', async () => {
    const { runtime, view } = await mountTeam(
      vi.fn().mockResolvedValue({ ok: true, value: { members: [] } }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No crew members yet')
    })
    expect(view.container.querySelector('#dsh-team-audit')).toBeNull()
    expect(view.container.textContent).not.toContain('No eval records yet')
    expect(view.container.textContent).not.toContain('Pending backlog')
    await runtime.dispose()
  })

  test('shows the empty copy before any member exists', async () => {
    const { runtime, view } = await mountTeam(
      vi.fn().mockResolvedValue({ ok: true, value: { members: [] } }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No crew members yet')
    })
    expect(view.container.textContent).not.toContain('Reading the crew')
    await runtime.dispose()
  })

  test('renders one card per member with its enabled badge and duty prompt', async () => {
    const { runtime, view } = await mountTeam(
      vi.fn().mockResolvedValue({
        ok: true,
        value: {
          members: [
            memberOf('a', { name: 'Product Wang', role: 'drafts the requirement note' }),
            memberOf('b', { name: 'Dev Li', enabled: false, model: 'deepseek-chat' }),
          ],
        },
      }),
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Product Wang')
    })
    expect(view.container.textContent).toContain('drafts the requirement note')
    expect(view.container.textContent).toContain('Dev Li')
    expect(view.container.textContent).toContain('Disabled')
    expect(view.container.textContent).toContain('deepseek-chat')
    await runtime.dispose()
  })

  test('the add modal submits a new member and closes on success', async () => {
    const crewAdd = vi.fn().mockResolvedValue({ ok: true, value: { member: memberOf('new') } })
    const { runtime, view } = await mountTeam(
      vi.fn().mockResolvedValue({ ok: true, value: { members: [] } }),
      { crewAdd },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No crew members yet')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add member' }))
    fireEvent.change(within(dialogEl()).getByPlaceholderText('e.g. Product Wang'), { target: { value: 'Test Zhou' } })
    fireEvent.change(within(dialogEl()).getByPlaceholderText(/duties, strengths/), { target: { value: 'runs the test pass' } })
    const submit = within(dialogEl()).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await vi.waitFor(() => {
      expect(crewAdd).toHaveBeenCalledWith({ name: 'Test Zhou', role: 'runs the test pass' })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    await runtime.dispose()
  })

  test('a rejected add keeps the modal open and shows the host error', async () => {
    const crewAdd = vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'name already taken' } })
    const { runtime, view } = await mountTeam(
      vi.fn().mockResolvedValue({ ok: true, value: { members: [] } }),
      { crewAdd },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No crew members yet')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add member' }))
    fireEvent.change(within(dialogEl()).getByPlaceholderText('e.g. Product Wang'), { target: { value: 'Test Zhou' } })
    fireEvent.change(within(dialogEl()).getByPlaceholderText(/duties, strengths/), { target: { value: 'runs the test pass' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('name already taken')
    })
    // The modal stays open with the draft intact.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect((within(dialogEl()).getByPlaceholderText('e.g. Product Wang') as HTMLInputElement).value).toBe('Test Zhou')
    await runtime.dispose()
  })

  test('toggle and remove call the host and refresh the roster', async () => {
    const crewUpdate = vi.fn().mockResolvedValue({ ok: true, value: { member: memberOf('a', { enabled: false }) } })
    const crewRemove = vi.fn().mockResolvedValue({ ok: true, value: { removed: true } })
    const { runtime, view } = await mountTeam(
      vi.fn().mockResolvedValue({ ok: true, value: { members: [memberOf('a')] } }),
      { crewUpdate, crewRemove },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('member-a')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Disable' }))
    await vi.waitFor(() => {
      expect(crewUpdate).toHaveBeenCalledWith({ memberId: 'a', enabled: false })
    })
    // The update's refresh re-renders the roster; settle before the next click.
    await settle()
    fireEvent.click(view.view.getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(crewRemove).toHaveBeenCalledWith({ memberId: 'a' })
    })
    await runtime.dispose()
  })

  test('a model catalog turns provider and model into dropdowns and submits the pick', async () => {
    const crewAdd = vi.fn().mockResolvedValue({ ok: true, value: { member: memberOf('new') } })
    const modelOptions = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        providers: [
          { provider: 'deepseek', providerName: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
        ],
      },
    })
    const { runtime, view } = await mountTeam(
      vi.fn().mockResolvedValue({ ok: true, value: { members: [] } }),
      { crewAdd, modelOptions },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No crew members yet')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add member' }))
    const pickOption = (trigger: HTMLElement, text: string): void => {
      fireEvent.click(trigger)
      const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find(el => el.textContent?.trim() === text)
      if (item === undefined) throw new Error(`menu item not found: ${text}`)
      fireEvent.click(item)
    }
    // The catalog read fills the provider dropdown; the model dropdown waits for the provider pick.
    await vi.waitFor(() => {
      expect(within(dialogEl()).getByLabelText('Provider (optional)').hasAttribute('data-select-control')).toBe(true)
    })
    pickOption(within(dialogEl()).getByLabelText('Provider (optional)'), 'DeepSeek')
    const modelSelect = within(dialogEl()).getByLabelText('Model (optional)')
    pickOption(modelSelect, 'DeepSeek Chat')
    fireEvent.change(within(dialogEl()).getByPlaceholderText('e.g. Product Wang'), { target: { value: 'Test Zhou' } })
    fireEvent.change(within(dialogEl()).getByPlaceholderText(/duties, strengths/), { target: { value: 'runs the test pass' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(crewAdd).toHaveBeenCalledWith({ name: 'Test Zhou', role: 'runs the test pass', provider: 'deepseek', model: 'deepseek-chat' })
    })
    await runtime.dispose()
  })

  test('an external executor kind submits on the member and badges the card', async () => {
    const created = memberOf('new', { agentKind: 'claude-code', name: 'CLI Wang' })
    const crewAdd = vi.fn().mockResolvedValue({ ok: true, value: { member: created } })
    const crewList = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { members: [] } })
      .mockResolvedValue({ ok: true, value: { members: [created] } })
    const { runtime, view } = await mountTeam(crewList, { crewAdd })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No crew members yet')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add member' }))
    const executorSelect = within(dialogEl()).getByLabelText('Executor')
    fireEvent.click(executorSelect)
    const claudeItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(el => el.textContent?.trim() === 'Claude Code')
    expect(claudeItem).toBeDefined()
    fireEvent.click(claudeItem!)
    // The external hint replaces the model pick: the CLI carries its own model.
    expect(dialogEl().textContent).toContain('Claude Code')
    fireEvent.change(within(dialogEl()).getByPlaceholderText('e.g. Product Wang'), { target: { value: 'CLI Wang' } })
    fireEvent.change(within(dialogEl()).getByPlaceholderText(/duties, strengths/), { target: { value: 'runs in claude code' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(crewAdd).toHaveBeenCalledWith({ name: 'CLI Wang', role: 'runs in claude code', agentKind: 'claude-code' })
    })
    // The card shows the executor badge.
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Claude Code')
    })
    await runtime.dispose()
  })

  test('probed agent kinds show availability status, refresh triggers re-probe, and external model overrides submit', async () => {
    const agentKindOptions = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        kinds: [
          { kind: 'builtin', command: '', available: true },
          { kind: 'claude-code', command: 'claude', available: true, executablePath: '/usr/local/bin/claude', version: '2.1.12' },
          { kind: 'codex', command: 'codex', available: false, reason: 'not found' },
          { kind: 'agy', command: 'agy', available: true, executablePath: '/usr/local/bin/agy', version: '0.9.4' },
        ],
      },
    })
    const crewAdd = vi.fn().mockResolvedValue({ ok: true, value: { member: memberOf('ext', { agentKind: 'claude-code', model: 'claude-sonnet-4-6' }) } })
    const { runtime, view } = await mountTeam(
      vi.fn().mockResolvedValue({ ok: true, value: { members: [] } }),
      { crewAdd, agentKindOptions },
    )
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No crew members yet')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add member' }))
    const executorSelect = within(dialogEl()).getByLabelText('Executor')
    await vi.waitFor(() => {
      expect(agentKindOptions).toHaveBeenCalled()
    })
    fireEvent.click(executorSelect)
    await vi.waitFor(() => {
      expect(Array.from(document.body.querySelectorAll('[role="menuitem"]')).map(el => el.textContent?.trim())).toContain('Codex (Not found)')
    })
    // Selecting an unavailable CLI warns directly in the modal.
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'Codex (Not found)')!)
    expect(dialogEl().textContent).toContain('not found in PATH')
    // Re-detect forces a refresh call.
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Re-detect' }))
    await vi.waitFor(() => {
      expect(agentKindOptions).toHaveBeenCalledWith({ refresh: true })
    })
    // Switching to an available external CLI shows detected path + version and allows --model override.
    fireEvent.click(executorSelect)
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'Claude Code')!)
    expect(dialogEl().textContent).toContain('/usr/local/bin/claude (2.1.12)')
    fireEvent.change(within(dialogEl()).getByPlaceholderText('e.g. Product Wang'), { target: { value: 'Spec Agent' } })
    fireEvent.change(within(dialogEl()).getByPlaceholderText(/duties, strengths/), { target: { value: 'reviews PRs' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Model override (optional)'), { target: { value: 'claude-sonnet-4-6' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(crewAdd).toHaveBeenCalledWith({
        name: 'Spec Agent',
        role: 'reviews PRs',
        agentKind: 'claude-code',
        model: 'claude-sonnet-4-6',
      })
    })
    await runtime.dispose()
  })
})
