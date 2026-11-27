// @vitest-environment jsdom
/** Slot-tier specs for the triggers browse page against a scripted Remote namespace. */
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


const THREAD = {
  id: 'thr-1',
  connectionId: 'conn-1',
  connector: 'jira',
  externalKey: 'PROJ-1',
  title: 'Fix the login flow',
  updatedAt: 1700000000000,
  url: 'https://jira.example.com/browse/PROJ-1',
}

const SOURCE = {
  id: 'src-1',
  connectionId: 'conn-1',
  kind: 'jira',
  enabled: true,
  jql: 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC',
  pollIntervalMs: 60000,
}

/** Mount the triggers page against a runtime whose remote answers are scripted. */
async function mountTriggers(remote: {
  sourceList?: ReturnType<typeof vi.fn>
  threadList?: ReturnType<typeof vi.fn>
  triggerList?: ReturnType<typeof vi.fn>
  connectionList?: ReturnType<typeof vi.fn>
  sourceAdd?: ReturnType<typeof vi.fn>
  sourceUpdate?: ReturnType<typeof vi.fn>
  sourcePoll?: ReturnType<typeof vi.fn>
  sourceRemove?: ReturnType<typeof vi.fn>
}): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']>; sourcesSection: () => HTMLElement }> {
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
      sourceList: vi.fn().mockResolvedValue({ ok: true, value: { sources: [] } }),
      sourceAdd: vi.fn(),
      sourceUpdate: vi.fn().mockResolvedValue({ ok: true, value: SOURCE }),
      sourcePoll: vi.fn(),
      sourceRemove: vi.fn().mockResolvedValue({ ok: true }),
      threadList: vi.fn().mockResolvedValue({ ok: true, value: { threads: [] } }),
      triggerList: vi.fn(),
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [{ id: 'conn-1', connector: 'jira', name: 'jira-prod' }] },
      }),
      ...remote,
    },
  })
  await runtime.mount({ inject: [...UI_INJECT, 'uiWorkspace'], apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  // The single tabbed panel defaults to the board; open the settings stack.
  fireEvent.click(view.view.getByRole('tab', { name: 'Settings' }))
  // The sources section inside the settings stack; the connection card in the
  // connections section above shares button names, so queries scope here.
  // The heading renders only once the sources read has settled, so this is a
  // lazy accessor, not a snapshot.
  return {
    runtime,
    view,
    sourcesSection: () => view.view.getByRole('heading', { name: 'Source instances' }).closest('section') as HTMLElement,
  }
}

describe('triggers page', () => {
  test('shows the empty copy before any source or thread exists', async () => {
    const { runtime, view } = await mountTriggers({})
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No Source instances yet')
    })
    expect(view.container.textContent).toContain('No triggers yet')
    await runtime.dispose()
  })

  test('renders one source row and one thread row with a deep link', async () => {
    const { runtime, view } = await mountTriggers({
      sourceList: vi.fn().mockResolvedValue({ ok: true, value: { sources: [SOURCE] } }),
      threadList: vi.fn().mockResolvedValue({ ok: true, value: { threads: [THREAD] } }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('jira-prod')
    })
    expect(view.container.textContent).toContain('Fix the login flow')
    const link = view.view.getByRole('link', { name: 'Fix the login flow' }) as HTMLAnchorElement
    expect(link.href).toBe('https://jira.example.com/browse/PROJ-1')
    await runtime.dispose()
  })

  test('expanding a thread lists its triggers with links to Jira', async () => {
    const triggerList = vi.fn().mockResolvedValue({
      ok: true,
      value: { triggers: [
        { id: 'trg-a', threadId: 'thr-1', externalKey: 'PROJ-1', url: 'https://jira.example.com/browse/PROJ-1', occurredAt: 1700000000000, collectedAt: 1700000001000 },
      ] },
    })
    const { runtime, view } = await mountTriggers({
      threadList: vi.fn().mockResolvedValue({ ok: true, value: { threads: [THREAD] } }),
      triggerList,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Fix the login flow')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Expand' }))
    await vi.waitFor(() => {
      expect(triggerList).toHaveBeenCalledWith({ threadId: 'thr-1' })
      expect(view.container.textContent).toContain('View in Jira')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Collapse' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).not.toContain('View in Jira')
    })
    await runtime.dispose()
  })

  test('a failing read offers the retry affordance', async () => {
    const { runtime, view } = await mountTriggers({
      threadList: vi.fn().mockRejectedValue(new Error('transport down')),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Failed to load')
    })
    await runtime.dispose()
  })
})

describe('source management', () => {
  test('adding a source from the picker submits the composed input', async () => {
    const sourceAdd = vi.fn().mockResolvedValue({ ok: true, value: SOURCE })
    const { runtime, view, sourcesSection } = await mountTriggers({ sourceAdd })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Source instances')
    })
    fireEvent.click(within(sourcesSection()).getByRole('button', { name: 'Add source' }))
    const submit = within(dialogEl()).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(within(dialogEl()).getByLabelText('Connection'))
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'jira-prod')!)
    expect(submit.disabled).toBe(false)
    fireEvent.change(within(dialogEl()).getByLabelText('JQL (blank uses the default watch)'), { target: { value: 'project = PROJ' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Poll interval (seconds, min 10)'), { target: { value: '30' } })
    fireEvent.click(submit)
    await vi.waitFor(() => {
      expect(sourceAdd).toHaveBeenCalledWith({
        connectionId: 'conn-1', kind: 'jira', acceptMode: 'auto', jql: 'project = PROJ', pollIntervalMs: 30000,
      })
    })
    await vi.waitFor(() => {
      expect(dialogElExists()).toBe(false)
    })
    await runtime.dispose()
  })

  test('the GitLab MR watch picks gitlab connections and hides the JQL field', async () => {
    const sourceAdd = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...SOURCE, id: 'src-2', connectionId: 'conn-gl', kind: 'gitlab-mr', jql: undefined },
    })
    const { runtime, view, sourcesSection } = await mountTriggers({
      sourceAdd,
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          connections: [
            { id: 'conn-1', connector: 'jira', name: 'jira-prod' },
            { id: 'conn-gl', connector: 'gitlab', name: 'gl-prod' },
          ],
        },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Source instances')
    })
    fireEvent.click(within(sourcesSection()).getByRole('button', { name: 'Add source' }))
    // Switch the watch kind to the GitLab MR source.
    fireEvent.click(within(dialogEl()).getByLabelText('Watch kind'))
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'GitLab MRs and comments')!)
    // The JQL field is gone; the connection picker now offers the gitlab one.
    expect(within(dialogEl()).queryByLabelText('JQL (blank uses the default watch)')).toBeNull()
    const connectionSelect = within(dialogEl()).getByLabelText('Connection')
    fireEvent.click(connectionSelect)
    const options = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(option => option.textContent?.trim())
    expect(options).toContain('gl-prod')
    expect(options).not.toContain('jira-prod')
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'gl-prod')!)
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(sourceAdd).toHaveBeenCalledWith({
        connectionId: 'conn-gl', kind: 'gitlab-mr', acceptMode: 'auto',
      })
    })
    await runtime.dispose()
  })

  test('the pipeline watch submits its watched projects', async () => {
    const sourceAdd = vi.fn().mockResolvedValue({ ok: true, value: SOURCE })
    const { runtime, view, sourcesSection } = await mountTriggers({
      sourceAdd,
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [{ id: 'conn-gl', connector: 'gitlab', name: 'gl-prod' }] },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Source instances')
    })
    fireEvent.click(within(sourcesSection()).getByRole('button', { name: 'Add source' }))
    fireEvent.click(within(dialogEl()).getByLabelText('Watch kind'))
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'GitLab pipeline failures')!)
    // The project picker appears; the JQL field does not.
    expect(within(dialogEl()).getByLabelText('Watched projects (comma-separated, e.g. group/alpha)')).not.toBeNull()
    expect(within(dialogEl()).queryByLabelText('JQL (blank uses the default watch)')).toBeNull()
    fireEvent.click(within(dialogEl()).getByLabelText('Connection'))
    fireEvent.click(Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'gl-prod')!)
    fireEvent.change(within(dialogEl()).getByLabelText('Watched projects (comma-separated, e.g. group/alpha)'), { target: { value: 'group/alpha, group/beta' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(sourceAdd).toHaveBeenCalledWith({
        connectionId: 'conn-gl', kind: 'gitlab-pipeline', acceptMode: 'auto', projects: ['group/alpha', 'group/beta'],
      })
    })
    await runtime.dispose()
  })

  test('poll now reports the outcome beside the source row', async () => {
    const sourcePoll = vi.fn().mockResolvedValue({ ok: true, value: { added: 2, duplicates: 1 } })
    const { runtime, view, sourcesSection } = await mountTriggers({
      sourceList: vi.fn().mockResolvedValue({ ok: true, value: { sources: [SOURCE] } }),
      sourcePoll,
    })
    await vi.waitFor(() => {
      expect(sourcesSection().textContent).toContain('jira-prod')
    })
    fireEvent.click(within(sourcesSection()).getByRole('button', { name: 'Poll now' }))
    await vi.waitFor(() => {
      expect(sourcePoll).toHaveBeenCalledWith({ id: 'src-1' })
      expect(sourcesSection().textContent).toContain('2 new, 1 duplicates')
    })
    await runtime.dispose()
  })

  test('a failed poll surfaces the error text', async () => {
    const sourcePoll = vi.fn().mockResolvedValue({
      ok: true,
      value: { added: 0, duplicates: 0, error: 'rate-limited: the instance asked to slow down (HTTP 429)' },
    })
    const { runtime, view, sourcesSection } = await mountTriggers({
      sourceList: vi.fn().mockResolvedValue({ ok: true, value: { sources: [SOURCE] } }),
      sourcePoll,
    })
    await vi.waitFor(() => {
      expect(sourcesSection().textContent).toContain('jira-prod')
    })
    fireEvent.click(within(sourcesSection()).getByRole('button', { name: 'Poll now' }))
    await vi.waitFor(() => {
      expect(sourcesSection().textContent).toContain('rate-limited')
    })
    await runtime.dispose()
  })

  test('the disable toggle flips the enabled flag', async () => {
    const sourceUpdate = vi.fn().mockResolvedValue({ ok: true, value: { ...SOURCE, enabled: false } })
    const { runtime, view, sourcesSection } = await mountTriggers({
      sourceList: vi.fn().mockResolvedValue({ ok: true, value: { sources: [SOURCE] } }),
      sourceUpdate,
    })
    await vi.waitFor(() => {
      expect(sourcesSection().textContent).toContain('jira-prod')
    })
    fireEvent.click(within(sourcesSection()).getByRole('button', { name: 'Disable' }))
    await vi.waitFor(() => {
      expect(sourceUpdate).toHaveBeenCalledWith({ id: 'src-1', enabled: false })
    })
    await runtime.dispose()
  })

  test('removing a source calls the remote', async () => {
    const sourceRemove = vi.fn().mockResolvedValue({ ok: true })
    const { runtime, view, sourcesSection } = await mountTriggers({
      sourceList: vi.fn().mockResolvedValue({ ok: true, value: { sources: [SOURCE] } }),
      sourceRemove,
    })
    await vi.waitFor(() => {
      expect(sourcesSection().textContent).toContain('jira-prod')
    })
    fireEvent.click(within(sourcesSection()).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(sourceRemove).toHaveBeenCalledWith({ id: 'src-1' })
    })
    await runtime.dispose()
  })
})

describe('triggers navigation entry', () => {
  test('registers a decorative icon into the sidebar panellist', async () => {
    const { runtime } = await mountTriggers({})
    const view = runtime.renderSlot('sidebar.panellist', {})
    expect(view.container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1)
    await runtime.dispose()
  })
})
