// @vitest-environment jsdom
/**
 * Slot-tier specs for Prompt Studio (AC-1, AC-2, AC-4, AC-5, AC-6, AC-7, AC-9, AC-10)
 * and TicketDetail dispatched prompt display.
 */
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { registerUi, PANEL_ID, UI_INJECT } from '../../src/client/register.ts'
import { TURN_IDS, TURN_REGISTRY } from '../../src/prompt/prompt-sections.ts'
import { PROMPT_VARIABLES } from '../../src/prompt/prompt-vars.ts'

function buildRegistryView(overrides?: {
  readonly globalExecutor?: Record<string, string>
  readonly pipelinePrompt?: Record<string, string>
  readonly stagePrompt?: Record<string, string>
  readonly revision?: number
}) {
  return {
    turns: TURN_IDS.map((id) => {
      const def = TURN_REGISTRY[id]
      return {
        id: def.id,
        label: def.label,
        description: def.description,
        scopeConfigurable: def.scopeConfigurable,
        sections: def.sections.map(s => ({
          id: s.id,
          label: s.label,
          description: s.description,
          defaultText: s.defaultText,
          locked: s.locked,
          ...(s.variants === undefined ? {} : { variants: s.variants }),
        })),
        dataBlocks: def.dataBlocks,
      }
    }),
    variables: PROMPT_VARIABLES,
    ...(overrides?.globalExecutor === undefined
      ? {}
      : { globalPrompts: { turns: { executor: { sections: overrides.globalExecutor } } } }),
    pipelines: [
      {
        id: 'pipe-1',
        name: 'Feature Flow',
        ...(overrides?.pipelinePrompt === undefined ? {} : { prompt: { sections: overrides.pipelinePrompt } }),
        stages: [
          {
            index: 0,
            memberId: 'crew-1',
            memberName: 'Coder',
            mode: 'execute' as const,
            ...(overrides?.stagePrompt === undefined ? {} : { prompt: { sections: overrides.stagePrompt } }),
          },
        ],
      },
    ],
    yaml: 'version: 2\ncrew: []\npipelines: []\nroutes: []\n',
    status: {
      filePath: '/tmp/dsh-home/dsh-manager/team-config.yaml',
      revision: overrides?.revision ?? 1,
      loadedAt: 1_700_000_000_000,
    },
  }
}

async function mountWithMocks(mocks: Record<string, unknown>) {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } })
  runtime.remote.provideNamespaces({
    dshManager: {
      crewList: vi.fn().mockResolvedValue({ ok: true, value: { members: [{ id: 'crew-1', name: 'Coder', role: 'code', enabled: true, createdAt: 1, updatedAt: 1 }] } }),
      modelOptions: vi.fn().mockResolvedValue({ ok: true, value: { providers: [] } }),
      agentKindOptions: vi.fn().mockResolvedValue({ ok: true, value: { kinds: [{ kind: 'builtin', command: '', available: true }] } }),
      pipelineList: vi.fn().mockResolvedValue({ ok: true, value: { pipelines: [] } }),
      ruleList: vi.fn().mockResolvedValue({ ok: true, value: { rules: [] } }),
      projectList: vi.fn().mockResolvedValue({ ok: true, value: { projects: [{ id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' }] } }),
      ticketList: vi.fn().mockResolvedValue({ ok: true, value: { tickets: [] } }),
      teamConfigStatus: vi.fn().mockResolvedValue({ ok: true, value: { filePath: '/tmp/dsh-home/dsh-manager/team-config.yaml', revision: 1, loadedAt: 1_700_000_000_000 } }),
      teamConfigReload: vi.fn().mockResolvedValue({ ok: true, value: { filePath: '/tmp/dsh-home/dsh-manager/team-config.yaml', revision: 1, loadedAt: 1_700_000_000_000 } }),
      stewardStatus: vi.fn().mockResolvedValue({ ok: true, value: { busy: false, backlog: 0, mode: 'auto', activity: [] } }),
      ...mocks,
    },
  })
  await runtime.mount({ inject: UI_INJECT, apply: registerUi })
  const view = runtime.renderSlot('main', {}, { entryKey: PANEL_ID })
  return { runtime, view }
}

describe('Prompt Studio UI & Steward prompt expansion', () => {
  test('lists all 8 turns, locked read-only sections, variable catalog, 2-step save, and live preview warnings', async () => {
    let registry = buildRegistryView({
      globalExecutor: { skills: 'global skills' },
      pipelinePrompt: { skills: 'pipeline skills' },
      stagePrompt: { skills: 'stage skills' },
    })

    const promptRegistry = vi.fn().mockImplementation(async () => ({ ok: true, value: registry }))
    const promptSave = vi.fn().mockImplementation(async (input: { sections: Record<string, string | null> }) => {
      if (input.sections.identity?.includes('{{nope}}')) {
        return { ok: false, error: { code: 'dshManager/prompt-invalid', message: 'prompt turn "executor" section "identity" uses unknown variable "nope"' } }
      }
      registry = buildRegistryView({ globalExecutor: { skills: input.sections.skills ?? 'global skills' }, revision: 2 })
      return { ok: true, value: { status: registry.status, registry } }
    })
    const promptRenderPreview = vi.fn().mockImplementation(async (input: { draftSections?: Record<string, string> }) => ({
      ok: true,
      value: {
        turnId: 'executor',
        text: input.draftSections?.identity ?? 'Rendered preview text',
        truncated: false,
        sections: [],
        missingVars: ['project.verifyDocs'],
        unknownVars: input.draftSections?.identity?.includes('{{nope}}') ? ['nope'] : [],
      },
    }))

    const { runtime, view } = await mountWithMocks({
      promptRegistry,
      promptSave,
      promptRenderPreview,
    })

    fireEvent.click(view.view.getByRole('tab', { name: 'Team' }))
    fireEvent.click(view.view.getByRole('tab', { name: 'Prompts' }))

    // AC-1: All 8 turns visible in left tree
    await vi.waitFor(() => {
      for (const id of TURN_IDS) {
        expect(document.getElementById(`dsh-prompt-node-turn-${id}`)).not.toBeNull()
      }
    })

    // AC-4: Locked section `report` has NO textarea/input, only read-only <pre>
    expect(document.getElementById('dsh-prompt-input-report')).toBeNull()
    expect(document.querySelector('#dsh-prompt-section-report pre')).not.toBeNull()

    // AC-6: Missing variable warning shown non-blockingly in preview
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Missing variables: project.verifyDocs')
    })

    // AC-5: Editing identity to {{nope}} triggers validation rejection on save
    const identityInput = document.getElementById('dsh-prompt-input-identity') as HTMLTextAreaElement
    fireEvent.change(identityInput, { target: { value: 'Hello {{nope}}' } })
    fireEvent.click(view.view.getByRole('button', { name: /Save changes/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }))

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('unknown variable "nope"')
    })

    // Close save confirm modal before switching node
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // AC-7: Switch to stage node, verify stage badge, Restore Inherited shows parent text & sends null in preview
    fireEvent.click(document.getElementById('dsh-prompt-node-stage-pipe-1-0')!)
    await vi.waitFor(() => {
      expect(document.getElementById('dsh-prompt-section-skills')?.textContent).toContain('stage')
      expect((document.getElementById('dsh-prompt-input-skills') as HTMLTextAreaElement).value).toBe('stage skills')
    })
    const skillsCard = document.getElementById('dsh-prompt-section-skills')!
    const restoreInheritedBtn = Array.from(skillsCard.querySelectorAll('button')).find(b => b.textContent === 'Restore inherited')!
    fireEvent.click(restoreInheritedBtn)
    expect((document.getElementById('dsh-prompt-input-skills') as HTMLTextAreaElement).value).toBe('pipeline skills')
    await vi.waitFor(() => {
      expect(promptRenderPreview).toHaveBeenLastCalledWith(expect.objectContaining({
        turnId: 'executor',
        pipelineId: 'pipe-1',
        stageIndex: 0,
        draftSections: { skills: null },
      }))
    })

    // Save confirm modal shows target summary & active pipelines note
    fireEvent.click(view.view.getByRole('button', { name: /Save changes/ }))
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Target:')
      expect(document.body.textContent).toContain('active pipelines')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // Switch to variable catalog and see read-only variables
    fireEvent.click(document.getElementById('dsh-prompt-node-variables')!)
    expect(view.container.textContent).toContain('{{project.verifyDocs}}')

    await runtime.dispose()
  })

  test('MonitorPage expands steward activity entry to inspect full rendered turn prompt (AC-9)', async () => {
    const stewardPrompt = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        prompt: {
          promptId: 'sp-1',
          turnId: 'steward.route',
          text: 'Route the accepted ticket T-1.\nCustom worktree instruction',
          truncated: false,
          sections: [],
          templateRevision: 3,
          renderedAt: 1_700_000_000_000,
        },
      },
    })

    const { runtime, view } = await mountWithMocks({
      stewardStatus: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          busy: false,
          backlog: 0,
          mode: 'auto',
          activity: [
            { at: 1_700_000_000_000, kind: 'eval-decision', text: 'route → Flow 1/2 · T-1', promptId: 'sp-1' },
          ],
        },
      }),
      stewardPrompt,
    })

    fireEvent.click(view.view.getByRole('tab', { name: 'Monitor' }))
    fireEvent.click(view.view.getByRole('tab', { name: 'Steward activity' }))

    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('route → Flow 1/2 · T-1')
    })

    fireEvent.click(view.view.getByRole('button', { name: 'View prompt' }))
    await vi.waitFor(() => {
      expect(stewardPrompt).toHaveBeenCalledWith({ promptId: 'sp-1' })
      expect(view.container.textContent).toContain('Custom worktree instruction')
    })

    await runtime.dispose()
  })

  test('OrchestrationWorkbench preset modal copies read-only preset into independent pipeline (AC-10)', async () => {
    const presetApply = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        pipeline: { id: 'pipe-bug', name: '缺陷修复', stages: [], createdAt: 1, updatedAt: 1 },
        createdMembers: [],
        status: { filePath: '/tmp/team-config.yaml', revision: 2, loadedAt: 2 },
      },
    })

    const { runtime, view } = await mountWithMocks({ presetApply })
    fireEvent.click(view.view.getByRole('tab', { name: 'Team' }))
    fireEvent.click(document.getElementById('dsh-team-preset-open')!)
    await vi.waitFor(() => {
      expect(document.getElementById('dsh-preset-copy-bug-fix')).not.toBeNull()
    })
    fireEvent.click(document.getElementById('dsh-preset-copy-bug-fix')!)
    await vi.waitFor(() => {
      expect(presetApply).toHaveBeenCalledWith({ presetId: 'bug-fix' })
    })

    await runtime.dispose()
  })
})
