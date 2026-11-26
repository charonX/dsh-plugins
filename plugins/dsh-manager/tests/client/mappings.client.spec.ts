// @vitest-environment jsdom
/** Slot-tier specs for the project-mapping config page against a scripted Remote namespace. */
import { fireEvent, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'
import { settingsStubs } from './settings-stubs.ts'

/** The open modal, portal-mounted on document.body; queries must scope here. */
function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) throw new Error('the dialog is not open')
  return el
}

/** Whether a modal is currently open on the document body. */
function dialogElExists(): boolean {
  return document.querySelector('[role="dialog"]') !== null
}


/** Mount the mappings page against a runtime whose remote answers are scripted. */
async function mountMappings(remote: {
  projectList?: ReturnType<typeof vi.fn>
  mappingList: ReturnType<typeof vi.fn>
  connectionList?: ReturnType<typeof vi.fn>
  mappingSet?: ReturnType<typeof vi.fn>
  mappingRemove?: ReturnType<typeof vi.fn>
}): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('uiWorkspace', { openSession: () => {} })
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      ...settingsStubs(),
      summary: vi.fn(),
      projectList: vi.fn().mockResolvedValue({
        ok: true,
        value: { projects: [
          { id: 'alpha', name: 'Alpha' },
          { id: 'beta', name: 'Beta' },
        ] },
      }),
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [{ id: 'conn-1', name: 'jira-prod' }] },
      }),
      mappingSet: vi.fn(),
      mappingRemove: vi.fn().mockResolvedValue({ ok: true }),
      ...remote,
    },
  })
  await runtime.mount({ inject: [...UI_INJECT, 'uiWorkspace'], apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  // The single tabbed panel defaults to the board; open the mappings tab.
  fireEvent.click(view.view.getByRole('tab', { name: 'Settings' }))
  return { runtime, view }
}

describe('mappings page', () => {
  test('shows the empty copy before any mapping exists', async () => {
    const { runtime, view } = await mountMappings({
      mappingList: vi.fn().mockResolvedValue({ ok: true, value: { mappings: [] } }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No mappings yet')
    })
    await runtime.dispose()
  })

  test('renders one row per mapping with the project name and validity', async () => {
    const { runtime, view } = await mountMappings({
      mappingList: vi.fn().mockResolvedValue({
        ok: true,
        value: { mappings: [
          { id: 'conn-1/PROJ', connectionId: 'conn-1', external: 'PROJ', projectId: 'alpha', updatedAt: 1, valid: true },
          { id: 'conn-1/OLD', connectionId: 'conn-1', external: 'OLD', projectId: 'gone-project', updatedAt: 2, valid: false },
        ] },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('PROJ')
    })
    expect(view.container.textContent).toContain('Alpha')
    // A dangling mapping renders as an explicit error, never a silent skip.
    expect(view.container.textContent).toContain('Target missing')
    expect(view.container.textContent).toContain('gone-project')
    await runtime.dispose()
  })

  test('a failing read offers the retry affordance', async () => {
    const { runtime, view } = await mountMappings({
      mappingList: vi.fn().mockRejectedValue(new Error('transport down')),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Failed to load')
    })
    await runtime.dispose()
  })
})

describe('add-mapping form', () => {
  test('the picker offers the harness projects and submits the composed mapping', async () => {
    const mappingSet = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'conn-1/PROJ', connectionId: 'conn-1', external: 'PROJ', projectId: 'alpha', updatedAt: 1, valid: true },
    })
    const { runtime, view } = await mountMappings({
      mappingList: vi.fn().mockResolvedValue({ ok: true, value: { mappings: [] } }),
      mappingSet,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Add mapping')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add mapping' }))
    const submit = within(dialogEl()).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    const pickOption = (trigger: HTMLElement, text: string): void => {
      fireEvent.click(trigger)
      const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find(el => el.textContent?.trim() === text)
      if (item === undefined) throw new Error(`menu item not found: ${text}`)
      fireEvent.click(item)
    }
    pickOption(within(dialogEl()).getByLabelText('Connection'), 'jira-prod')
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(dialogEl()).getByLabelText('External object (Jira project key / GitLab repo path)'), {
      target: { value: 'PROJ' },
    })
    expect(submit.disabled).toBe(true)
    pickOption(within(dialogEl()).getByLabelText('DSH project'), 'Alpha')
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await vi.waitFor(() => {
      expect(mappingSet).toHaveBeenCalledWith({ connectionId: 'conn-1', external: 'PROJ', projectId: 'alpha' })
    })
    await vi.waitFor(() => {
      expect(dialogElExists()).toBe(false)
    })
    await runtime.dispose()
  })

  test('a rejected mapping shows an explicit error and keeps the input', async () => {
    // The project existed when listed but the host rejects the save — the
    // error renders explicitly and the input survives for correction.
    const mappingSet = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'dshManager/project-not-found', message: 'project gone does not exist' },
    })
    const { runtime, view } = await mountMappings({
      mappingList: vi.fn().mockResolvedValue({ ok: true, value: { mappings: [] } }),
      mappingSet,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Add mapping')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add mapping' }))
    const pickOption = (trigger: HTMLElement, text: string): void => {
      fireEvent.click(trigger)
      const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find(el => el.textContent?.trim() === text)
      if (item === undefined) throw new Error(`menu item not found: ${text}`)
      fireEvent.click(item)
    }
    pickOption(within(dialogEl()).getByLabelText('Connection'), 'jira-prod')
    fireEvent.change(within(dialogEl()).getByLabelText('External object (Jira project key / GitLab repo path)'), {
      target: { value: 'PROJ' },
    })
    pickOption(within(dialogEl()).getByLabelText('DSH project'), 'Beta')
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('Saving failed')
    })
    const external = within(dialogEl()).getByLabelText('External object (Jira project key / GitLab repo path)') as HTMLInputElement
    expect(external.value).toBe('PROJ')
    await runtime.dispose()
  })

  test('removing a mapping calls the remote', async () => {
    const mappingRemove = vi.fn().mockResolvedValue({ ok: true })
    const { runtime, view } = await mountMappings({
      mappingList: vi.fn().mockResolvedValue({
        ok: true,
        value: { mappings: [
          { id: 'conn-1/PROJ', connectionId: 'conn-1', external: 'PROJ', projectId: 'alpha', updatedAt: 1, valid: true },
        ] },
      }),
      mappingRemove,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('PROJ')
    })
    // Scope to the mappings section: the connection card in the section above
    // carries a Remove button of its own.
    const mappingsSection = view.view.getByRole('heading', { name: 'Project mappings' }).closest('section') as HTMLElement
    fireEvent.click(within(mappingsSection).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(mappingRemove).toHaveBeenCalledWith({ id: 'conn-1/PROJ' })
    })
    await runtime.dispose()
  })
})

describe('mappings navigation entry', () => {
  test('registers a decorative icon into the sidebar panellist', async () => {
    const { runtime } = await mountMappings({
      mappingList: vi.fn().mockResolvedValue({ ok: true, value: { mappings: [] } }),
    })
    const view = runtime.renderSlot('sidebar.panellist', {})
    expect(view.container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1)
    await runtime.dispose()
  })
})
