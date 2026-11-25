// @vitest-environment jsdom
/** Slot-tier specs for the connections config page against a scripted Remote namespace. */
import { fireEvent, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionView } from '../../src/connections/wire-types.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'
import { settingsStubs } from './settings-stubs.ts'


/** Whether a modal is currently open on the document body. */
function dialogElExists(): boolean {
  return document.querySelector('[role="dialog"]') !== null
}

/** The open modal, portal-mounted on document.body; queries must scope here. */
function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) throw new Error('the dialog is not open')
  return el
}

function connectionOf(id: string, overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id,
    connector: 'jira',
    name: `conn-${id}`,
    deployment: 'server-dc',
    baseUrl: 'https://jira.example.com',
    authMethod: 'pat',
    enabled: true,
    status: 'unconfigured',
    ...overrides,
  }
}

/** Mount the connections page against a runtime whose remote answers are scripted. */
async function mountConnections(remote: {
  connectionList: ReturnType<typeof vi.fn>
  connectionAdd?: ReturnType<typeof vi.fn>
  connectionUpdate?: ReturnType<typeof vi.fn>
  connectionTest?: ReturnType<typeof vi.fn>
  connectionRemove?: ReturnType<typeof vi.fn>
  connectionDeleteInfo?: ReturnType<typeof vi.fn>
}): Promise<{ runtime: SlotTestRuntime; view: ReturnType<SlotTestRuntime['renderSlot']> }> {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      ...settingsStubs(),
      summary: vi.fn(),
      connectionAdd: vi.fn(),
      connectionUpdate: vi.fn(),
      connectionTest: vi.fn(),
      connectionRemove: vi.fn(),
      connectionDeleteInfo: vi.fn().mockResolvedValue({ ok: true, value: { sources: 0, mappings: 0 } }),
      ...remote,
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  // The single tabbed panel defaults to the board; open the connections tab.
  fireEvent.click(view.view.getByRole('tab', { name: 'Settings' }))
  return { runtime, view }
}

describe('connections page', () => {
  test('shows the empty copy before any connection exists', async () => {
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('No connections yet')
    })
    await runtime.dispose()
  })

  test('renders one card per connection with its health badge', async () => {
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [
          connectionOf('a', { name: 'prod', status: 'ok' }),
          connectionOf('b', { name: 'stale', status: 'invalid-credentials' }),
        ] },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('prod')
    })
    expect(view.container.textContent).toContain('stale')
    expect(view.container.textContent).toContain('Healthy')
    expect(view.container.textContent).toContain('Invalid credentials')
    await runtime.dispose()
  })

  test('a gitlab connection missing glab shows the badge and a copyable install command', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async (text: string) => { written.push(text) }) },
      configurable: true,
    })
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [connectionOf('a', {
          name: 'git', connector: 'gitlab', status: 'dependency-missing', installCommand: 'winget install GLab.Glab',
        })] },
      }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Dependency missing')
    })
    // The card carries the install guidance and the copy affordance.
    const copy = view.view.getByRole('button', { name: 'Copy install command' })
    fireEvent.click(copy)
    await vi.waitFor(() => {
      expect(written).toEqual(['winget install GLab.Glab'])
      expect(view.container.textContent).toContain('Copied')
    })
    await runtime.dispose()
  })

  test('a dependency-missing test verdict shows the install hint alongside the detail', async () => {
    const connectionTest = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ok: false, reason: 'dependency-missing',
        detail: 'the glab CLI is not installed; Source features need it (connectivity testing still works)',
        installCommand: 'brew install glab',
      },
    })
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({
        ok: true, value: { connections: [connectionOf('a', { name: 'git', connector: 'gitlab' })] },
      }),
      connectionTest,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('git')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Test connection' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('glab CLI is not installed')
    })
    expect(view.container.textContent).toContain('brew install glab')
    expect(connectionTest).toHaveBeenCalledWith('a')
    await runtime.dispose()
  })

  test('a failing list read offers the retry affordance', async () => {
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockRejectedValue(new Error('transport down')),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Failed to load')
    })
    await runtime.dispose()
  })

  test('a test click shows the verdict, distinguishing permission failures', async () => {
    const connectionTest = vi.fn().mockResolvedValue({
      ok: true,
      value: { ok: false, reason: 'insufficient-permission', detail: 'the PAT is valid but lacks permission (HTTP 403)' },
    })
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [connectionOf('a', { name: 'prod' })] },
      }),
      connectionTest,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('prod')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Test connection' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Insufficient permission')
    })
    expect(view.container.textContent).toContain('lacks permission')
    expect(connectionTest).toHaveBeenCalledWith('a')
    await runtime.dispose()
  })

  test('a successful test shows the success verdict', async () => {
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [connectionOf('a', { name: 'prod' })] },
      }),
      connectionTest: vi.fn().mockResolvedValue({ ok: true, value: { ok: true } }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('prod')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Test connection' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Connection succeeded.')
    })
    await runtime.dispose()
  })
})

describe('add-connection form', () => {
  test('the submit button stays disabled until every required field is valid', async () => {
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Add connection')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add connection' }))
    const dialog = dialogEl()
    expect(dialog.textContent).toContain('Add a connection')
    const submit = within(dialogEl()).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(dialogEl()).getByLabelText('Name'), { target: { value: 'prod' } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(dialogEl()).getByLabelText('Instance URL'), { target: { value: 'not-a-url' } })
    expect(submit.disabled).toBe(true)
    expect(document.body.textContent).toContain('Fill in a name')
    fireEvent.change(within(dialogEl()).getByLabelText('Instance URL'), { target: { value: 'https://jira.example.com' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Access token (PAT)'), { target: { value: 'pat-value' } })
    expect(submit.disabled).toBe(false)
    await runtime.dispose()
  })

  test('a confirmed submit closes the modal; a failure keeps it open with the error', async () => {
    const connectionAdd = vi.fn().mockResolvedValue({ ok: true, value: connectionOf('new') })
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
      connectionAdd,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Add connection')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add connection' }))
    fireEvent.change(within(dialogEl()).getByLabelText('Name'), { target: { value: 'prod' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Instance URL'), { target: { value: 'https://jira.example.com' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Access token (PAT)'), { target: { value: 'pat-value' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(connectionAdd).toHaveBeenCalledWith({
        connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl: 'https://jira.example.com',
        authMethod: 'pat', secret: 'pat-value',
      })
    })
    await vi.waitFor(() => {
      expect(dialogElExists()).toBe(false)
    })

    // A failing add keeps the modal open, shows the error, and keeps the input.
    const failing = vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'boom' } })
    const second = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
      connectionAdd: failing,
    })
    await vi.waitFor(() => {
      expect(second.view.container.textContent).toContain('Add connection')
    })
    fireEvent.click(second.view.view.getByRole('button', { name: 'Add connection' }))
    fireEvent.change(within(dialogEl()).getByLabelText('Name'), { target: { value: 'prod' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Instance URL'), { target: { value: 'https://jira.example.com' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Access token (PAT)'), { target: { value: 'pat-value' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(dialogEl().textContent).toContain('boom')
    })
    expect((within(dialogEl()).getByLabelText('Name') as HTMLInputElement).value).toBe('prod')
    await second.runtime.dispose()
    await runtime.dispose()
  })

  test('the connector choice rides the submitted input', async () => {
    const connectionAdd = vi.fn().mockResolvedValue({ ok: true, value: connectionOf('new', { connector: 'gitlab' }) })
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
      connectionAdd,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Add connection')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add connection' }))
    fireEvent.click(within(dialogEl()).getByLabelText('Connector'))
    const gitlabItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(el => el.textContent?.trim() === 'GitLab')
    fireEvent.click(gitlabItem!)
    fireEvent.change(within(dialogEl()).getByLabelText('Name'), { target: { value: 'git' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Instance URL'), { target: { value: 'https://gitlab.example.com' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Access token (PAT)'), { target: { value: 'pat-value' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(connectionAdd).toHaveBeenCalledWith({
        connector: 'gitlab', name: 'git', deployment: 'server-dc', baseUrl: 'https://gitlab.example.com',
        authMethod: 'pat', secret: 'pat-value',
      })
    })
    await runtime.dispose()
  })

  test('choosing Basic auth reveals the identity field and rides the submitted input', async () => {
    const connectionAdd = vi.fn().mockResolvedValue({ ok: true, value: connectionOf('new') })
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
      connectionAdd,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Add connection')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Add connection' }))
    expect(within(dialogEl()).queryByLabelText('Username or email')).toBeNull()
    fireEvent.click(within(dialogEl()).getByLabelText('Auth method'))
    const basicItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(el => el.textContent?.trim() === 'Username + password (Basic)')
    fireEvent.click(basicItem!)
    fireEvent.change(within(dialogEl()).getByLabelText('Username or email'), { target: { value: 'alice@example.com' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Name'), { target: { value: 'cloud' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Instance URL'), { target: { value: 'https://example.atlassian.net' } })
    fireEvent.change(within(dialogEl()).getByLabelText('Password or API token'), { target: { value: 'token-value' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => {
      expect(connectionAdd).toHaveBeenCalledWith({
        connector: 'jira', name: 'cloud', deployment: 'server-dc', baseUrl: 'https://example.atlassian.net',
        authMethod: 'basic', authIdentity: 'alice@example.com', secret: 'token-value',
      })
    })
    await runtime.dispose()
  })

  test('edit prefills the form and saves through connectionUpdate; the credential rotates only when retyped', async () => {
    const connectionUpdate = vi.fn().mockResolvedValue({ ok: true, value: connectionOf('a', { name: 'renamed' }) })
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({
        ok: true,
        value: { connections: [connectionOf('a', { name: 'prod', authIdentity: undefined })] },
      }),
      connectionUpdate,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('prod')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Edit' }))
    const nameInput = within(dialogEl()).getByLabelText('Name') as HTMLInputElement
    expect(nameInput.value).toBe('prod')
    fireEvent.change(nameInput, { target: { value: 'renamed' } })
    fireEvent.click(within(dialogEl()).getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => {
      expect(connectionUpdate).toHaveBeenCalledWith({
        id: 'a', name: 'renamed', deployment: 'server-dc', baseUrl: 'https://jira.example.com', authMethod: 'pat',
      })
    })
    await vi.waitFor(() => {
      expect(dialogElExists()).toBe(false)
    })
    await runtime.dispose()
  })

  test('the disable toggle flips the enabled flag through connectionUpdate', async () => {
    const connectionUpdate = vi.fn().mockResolvedValue({ ok: true, value: connectionOf('a', { enabled: false }) })
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({
        ok: true, value: { connections: [connectionOf('a', { name: 'prod' })] },
      }),
      connectionUpdate,
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('prod')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Disable' }))
    await vi.waitFor(() => {
      expect(connectionUpdate).toHaveBeenCalledWith({ id: 'a', enabled: false })
    })
    await runtime.dispose()
  })

  test('a removal with dependents warns first and removes on the second click', async () => {
    const connectionRemove = vi.fn().mockResolvedValue({ ok: true })
    const { runtime, view } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({
        ok: true, value: { connections: [connectionOf('a', { name: 'prod' })] },
      }),
      connectionRemove,
      connectionDeleteInfo: vi.fn().mockResolvedValue({ ok: true, value: { sources: 2, mappings: 1 } }),
    })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('prod')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Click again to confirm')
    })
    expect(connectionRemove).not.toHaveBeenCalled()
    fireEvent.click(view.view.getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => {
      expect(connectionRemove).toHaveBeenCalledWith('a')
    })
    await runtime.dispose()
  })
})

describe('connections navigation entry', () => {
  test('registers a decorative icon into the sidebar panellist', async () => {
    const { runtime } = await mountConnections({
      connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
    })
    const view = runtime.renderSlot('sidebar.panellist', {})
    expect(view.container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1)
    await runtime.dispose()
  })
})
