/** Shared empty-state stubs for the settings stack: the Settings tab renders
    connections, mappings, and triggers together, so each page spec must keep
    the other two sections in their quiet empty state — otherwise their error
    copies and retry buttons collide with the page under test. */
import { vi } from 'vitest'

/** The stubbed settings reads; a spec's own mocks override them by spread order. */
export function settingsStubs(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    projectList: vi.fn().mockResolvedValue({ ok: true, value: { projects: [] } }),
    mappingList: vi.fn().mockResolvedValue({ ok: true, value: { mappings: [] } }),
    mappingSet: vi.fn().mockResolvedValue({ ok: false }),
    mappingRemove: vi.fn().mockResolvedValue({ ok: true }),
    sourceList: vi.fn().mockResolvedValue({ ok: true, value: { sources: [] } }),
    threadList: vi.fn().mockResolvedValue({ ok: true, value: { threads: [] } }),
    triggerList: vi.fn().mockResolvedValue({ ok: true, value: { triggers: [] } }),
    sourceAdd: vi.fn().mockResolvedValue({ ok: false }),
    sourceUpdate: vi.fn().mockResolvedValue({ ok: false }),
    sourcePoll: vi.fn().mockResolvedValue({ ok: false }),
    sourceRemove: vi.fn().mockResolvedValue({ ok: true }),
    // The general section reads once on mount and stays quiet.
    uiSettings: vi.fn().mockResolvedValue({ ok: true, value: { settings: {} } }),
    uiSettingsUpdate: vi.fn().mockResolvedValue({ ok: true, value: { settings: {} } }),
    imSettings: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        available: false,
        settings: { enabled: false, notifyAttention: true, notifyProgress: false },
        bots: [],
      },
    }),
    imSettingsUpdate: vi.fn().mockResolvedValue({ ok: false }),
    imTestSend: vi.fn().mockResolvedValue({ ok: false }),
    // The crew roster reads once on mount and stays quiet.
    crewList: vi.fn().mockResolvedValue({ ok: true, value: { members: [] } }),
    modelOptions: vi.fn().mockResolvedValue({ ok: true, value: { providers: [] } }),
    agentKindOptions: vi.fn().mockResolvedValue({ ok: true, value: { kinds: [] } }),
    crewAdd: vi.fn().mockResolvedValue({ ok: false }),
    crewUpdate: vi.fn().mockResolvedValue({ ok: false }),
    crewRemove: vi.fn().mockResolvedValue({ ok: true }),
    // The pipeline list reads once on mount and stays quiet.
    pipelineList: vi.fn().mockResolvedValue({ ok: true, value: { pipelines: [] } }),
    pipelineAdd: vi.fn().mockResolvedValue({ ok: false }),
    pipelineUpdate: vi.fn().mockResolvedValue({ ok: false }),
    pipelineRemove: vi.fn().mockResolvedValue({ ok: true }),
    pipelineReferencesOf: vi.fn().mockResolvedValue({ ok: true, value: { references: [] } }),
    // The route rules read once on mount and stay quiet.
    ruleList: vi.fn().mockResolvedValue({ ok: true, value: { rules: [] } }),
    ruleAdd: vi.fn().mockResolvedValue({ ok: false }),
    ruleUpdate: vi.fn().mockResolvedValue({ ok: false }),
    ruleRemove: vi.fn().mockResolvedValue({ ok: true }),
    ruleReferencesOfPipeline: vi.fn().mockResolvedValue({ ok: true, value: { rules: [] } }),
    // The run records on the team page read once on mount and stay quiet.
    evalList: vi.fn().mockResolvedValue({ ok: true, value: { evals: [] } }),
    connectionList: vi.fn().mockResolvedValue({ ok: true, value: { connections: [] } }),
    stewardStatus: vi.fn().mockResolvedValue({ ok: true, value: { busy: false, backlog: 0, mode: 'auto', activity: [] } }),
    policyList: vi.fn().mockResolvedValue({ ok: true, value: { policies: [] } }),
    policyUpdate: vi.fn().mockResolvedValue({ ok: false }),
    policyDiff: vi.fn().mockResolvedValue({ ok: false }),
  }
}
