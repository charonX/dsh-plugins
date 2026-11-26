// @vitest-environment jsdom
/** Slot-tier specs for the simplified FlowWorkbench and SkillCatalogSection inside TeamPage. */
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { DiscoveredSkill, FlowDef } from '../../src/flow/flow-ir.ts'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'
import { settingsStubs } from './settings-stubs.ts'

async function mountTeamPage(overrides: Record<string, unknown> = {}) {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      ...settingsStubs(),
      ...overrides,
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  fireEvent.click(view.view.getByRole('tab', { name: 'Team & Flows' }))
  return { runtime, view }
}

describe('FlowWorkbench & SkillCatalog UI', () => {
  test('renders empty fallback hint, allows creating a knowledge flow, and switches to Skill catalog', async () => {
    const flows: FlowDef[] = []
    const skills: DiscoveredSkill[] = [
      {
        name: 'knowledge-playbook',
        description: 'End-to-end article writing playbook',
        source: 'workspace',
        path: '/ws/.dsh/skills/knowledge-playbook/SKILL.md',
        enabled: true,
      },
    ]

    const flowAdd = vi.fn().mockImplementation(async (input: { name: string; when: string; workspaceMode: 'in-place' | 'worktree' | 'auto'; steps: FlowDef['steps'] }) => {
      const created: FlowDef = {
        id: 'flow-created',
        name: input.name,
        when: input.when,
        workspaceMode: input.workspaceMode,
        enabled: true,
        steps: input.steps,
        createdAt: 10,
        updatedAt: 10,
      }
      flows.push(created)
      return { ok: true, value: { flow: created } }
    })

    const flowImportPlaybook = vi.fn().mockImplementation(async ({ ref }: { kind: string; ref: string }) => {
      const compiled: FlowDef = {
        id: 'flow-compiled',
        name: `Compiled ${ref}`,
        when: 'knowledge creation tasks',
        workspaceMode: 'in-place',
        enabled: true,
        source: { kind: 'skill', ref, hash: 'abcdef1234567890', compiledAt: 20 },
        steps: [
          { id: 'outline', name: 'Outline', skills: ['knowledge-playbook'] },
          { id: 'review', name: 'Review', skills: ['verify'], readOnly: true, onFail: 'outline' },
        ],
        createdAt: 20,
        updatedAt: 20,
      }
      flows.push(compiled)
      return { ok: true, value: { flow: compiled, cacheHit: false, method: 'markdown' as const } }
    })

    const { runtime, view } = await mountTeamPage({
      flowList: vi.fn().mockImplementation(async () => ({ ok: true, value: { flows: [...flows] } })),
      skillCatalog: vi.fn().mockResolvedValue({ ok: true, value: { skills } }),
      flowAdd,
      flowImportPlaybook,
    })

    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Unmatched tasks run directly via single-step generic execution')
    })

    // No Crew roster or Prompt tabs remain in Team & Flows.
    expect(view.view.queryByRole('tab', { name: 'Crew roster' })).toBeNull()
    expect(view.view.queryByRole('tab', { name: 'Prompts' })).toBeNull()

    // Create a flow via New flow modal (Modal renders in a portal on document.body).
    fireEvent.click(view.view.getByRole('button', { name: 'New flow' }))
    fireEvent.change(screen.getByPlaceholderText('e.g. Knowledge creation, Code dev'), {
      target: { value: 'Knowledge Writing' },
    })
    fireEvent.change(screen.getByPlaceholderText('Describe in plain language which tasks match this flow…'), {
      target: { value: 'Write essays and design docs in non-git folders' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }))

    await vi.waitFor(() => {
      expect(flowAdd).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(await view.view.findByRole('tab', { name: 'List' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Knowledge Writing')
    })

    // Switch to Skills tab and compile a skill as a Flow IR.
    fireEvent.click(view.view.getByRole('tab', { name: 'Skills' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('knowledge-playbook')
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Compile as flow' }))

    await vi.waitFor(() => {
      expect(flowImportPlaybook).toHaveBeenCalledWith({ kind: 'skill', ref: 'knowledge-playbook' })
    })
    fireEvent.click(await view.view.findByRole('tab', { name: 'List' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Compiled knowledge-playbook')
    })

    await runtime.dispose()
  })

  test('applies knowledge-creation preset and shows flow topology nodes & onFail rework edge', async () => {
    const flows: FlowDef[] = []
    const flowPresetApply = vi.fn().mockImplementation(async ({ presetId }: { presetId: string }) => {
      const flow: FlowDef = {
        id: `preset-${presetId}`,
        name: 'Knowledge Creation Flow',
        when: 'Writing articles and outlines',
        workspaceMode: 'in-place',
        enabled: true,
        steps: [
          { id: 'research', name: 'Research & Outline', skills: ['how'], readOnly: true },
          { id: 'draft', name: 'Write Draft', skills: [] },
          { id: 'review', name: 'Fact & Logic Review', skills: ['verify', 'code-review'], readOnly: true, onFail: 'draft' },
        ],
        createdAt: 1,
        updatedAt: 1,
      }
      flows.push(flow)
      return { ok: true, value: { flow, status: { filePath: '/tmp/team-config.yaml', revision: 2, loadedAt: 2 } } }
    })

    const { runtime, view } = await mountTeamPage({
      flowList: vi.fn().mockImplementation(async () => ({ ok: true, value: { flows: [...flows] } })),
      flowPresetApply,
    })

    await vi.waitFor(() => {
      expect(view.view.getByRole('button', { name: 'Copy from preset' })).toBeTruthy()
    })
    fireEvent.click(view.view.getByRole('button', { name: 'Copy from preset' }))
    await vi.waitFor(() => {
      expect(screen.getByText('知识创作与内容生产')).toBeTruthy()
    })
    const copyButtons = screen.getAllByRole('button', { name: 'Copy as flow' })
    fireEvent.click(copyButtons[copyButtons.length - 1]!)

    await vi.waitFor(() => {
      expect(flowPresetApply).toHaveBeenCalledWith({ presetId: 'knowledge-creation' })
    })
    fireEvent.click(await view.view.findByRole('tab', { name: 'List' }))
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Knowledge Creation Flow')
      expect(view.container.textContent).toContain('Fact & Logic Review')
    })

    await runtime.dispose()
  })
})
