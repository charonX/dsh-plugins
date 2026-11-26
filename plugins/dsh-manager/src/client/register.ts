/**
 * UI registration for the manager panel: ONE sidebar entry whose tabbed page
 * holds every facet (board, steward, eval records/policy, and the
 * settings stack). Split from the client entry so slot-tier tests can mount
 * the UI against a scripted Remote namespace without the generated-contribution
 * mount.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { ManagerPage } from './ManagerPage.tsx'
import { BoardNavIcon } from './NavIcon.tsx'
import { createBoardSource } from './board-source.ts'
import { createConnectionsSource } from './connections-source.ts'
import { createEvalsSource } from './evals-source.ts'
import { createFlowSource } from './flow-source.ts'
import { createMappingsSource } from './mappings-source.ts'
import { createPolicySource } from './policy-source.ts'
import { createTeamConfigSource } from './team-config-source.ts'
import { createNotificationsSource } from './notifications-source.ts'
import { createStewardSource } from './steward-source.ts'
import { createTriggersSource } from './triggers-source.ts'
import { createUiSettingsSource } from './ui-settings-source.ts'
import { createImSettingsSource } from './im-settings-source.ts'
import { en, NS, zh } from './locales.ts'

/** Identity shared by the sidebar entry and its main-slot occupant. */
export const PANEL_ID = 'dsh-manager-board' as MainPanelId

/** Services the UI registration reads; also the slot-tier test's inject list. */
export const UI_INJECT = ['remote.dshManager', 'slots', 'locale']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Board and connections page copy. */
    'dshManager': keyof typeof zh
  }
}

/** Register the dictionary, the tabbed panel, and the single navigation entry on the caller's fiber. */
export function registerUi(ctx: ClientContext): void {
  // Resolve the namespaced Remote once, inside the caller's UI_INJECT grant:
  // every read fires later from a React callback, where a fresh
  // `ctx.remote.dshManager` access is refused by the inject guard (the module
  // entry cannot declare the namespace — it mounts the contribution itself).
  // The captured service object's methods close over the mounted transport,
  // so calls after the grant window need no context resolution.
  const dsh = ctx.remote.dshManager
  // The panel's display name: the localized default, or the user's custom
  // name from the UI settings. The custom name overlays `app.title` in every
  // dictionary before registration — the sidebar label thunk and the page
  // headings both read it, and re-registering republishes the locale so live
  // surfaces re-render.
  let customTitle: string | undefined
  let disposeDictionaries: (() => void) | undefined
  const registerDictionaries = (): void => {
    disposeDictionaries?.()
    disposeDictionaries = ctx.locale.register(NS, {
      zh: customTitle === undefined ? zh : { ...zh, 'app.title': customTitle },
      en: customTitle === undefined ? en : { ...en, 'app.title': customTitle },
    })
  }
  const applyTitle = (title: string | undefined): void => {
    if ((customTitle ?? undefined) === (title ?? undefined)) return
    customTitle = title
    registerDictionaries()
  }
  ctx.effect(() => {
    registerDictionaries()
    return () => disposeDictionaries?.()
  }, 'dsh-manager: dictionaries')
  // The custom name loads at registration, not at the settings tab: the
  // sidebar shows it from the first paint after the read lands.
  void (async () => {
    const result = await dsh.uiSettings()
    if (result.ok) applyTitle(result.value?.settings.title)
  })().catch(() => {})
  const boardSource = createBoardSource({
    read: async filter => {
      const result = await dsh.summary(filter)
      return result.ok ? result.value : undefined
    },
    readTickets: async filter => {
      const result = await dsh.ticketList(filter)
      return result.ok ? result.value?.tickets : undefined
    },
    readCandidates: async () => {
      const result = await dsh.candidateList()
      return result.ok ? result.value?.candidates : undefined
    },
    readConnections: async () => {
      const result = await dsh.connectionList()
      return result.ok ? result.value?.connections : undefined
    },
    readProjects: async () => {
      const result = await dsh.projectList()
      return result.ok ? result.value?.projects : undefined
    },
    accept: async evalId => await dsh.acceptCandidate({ evalId }),
    requeue: async evalId => await dsh.evalRequeue({ evalId }),
    readEvals: async () => {
      const result = await dsh.evalList({})
      return result.ok ? result.value?.evals : undefined
    },
    submitManual: async input => await dsh.manualInput(input),
    readTicketDetail: async ticketId => {
      const result = await dsh.ticketDetail({ ticketId })
      return result.ok ? result.value : undefined
    },
    readFlowTimeline: async ticketId => {
      const result = await dsh.flowTimeline({ ticketId })
      return result.ok ? result.value : undefined
    },
    readTicketChangeDiff: async input => {
      const result = await dsh.ticketChangeDiff(input)
      return result.ok ? result.value?.diff : undefined
    },
    dispatchTicket: async ticketId => {
      if (typeof dsh.dispatchTicket !== 'function') return false
      const result = await dsh.dispatchTicket({ ticketId })
      return result.ok
    },
    cancelDispatch: async dispatchId => {
      if (typeof dsh.dispatchCancel !== 'function') return false
      const result = await dsh.dispatchCancel({ dispatchId })
      return result.ok && (result.value?.cancelled ?? false)
    },
    readTicketWorktree: async ticketId => {
      if (typeof dsh.ticketWorktree !== 'function') return undefined
      const result = await dsh.ticketWorktree({ ticketId })
      return result.ok ? result.value?.worktree : undefined
    },
    removeTicketWorktree: async ticketId => {
      if (typeof dsh.ticketWorktreeRemove !== 'function') return false
      const result = await dsh.ticketWorktreeRemove({ ticketId })
      return result.ok && (result.value?.removed ?? false)
    },
    setTicketDependencies: async input => {
      if (typeof dsh.setTicketDependencies !== 'function') return false
      const result = await dsh.setTicketDependencies(input)
      return result.ok
    },
    closeTicket: async input => {
      if (typeof dsh.closeTicket !== 'function') return false
      const result = await dsh.closeTicket(input)
      return result.ok
    },
    readAttentions: async () => {
      // The descriptor declares one parameter; pass the empty filter explicitly.
      const result = await dsh.attentionList({})
      return result.ok ? result.value?.attentions.filter(attention => attention.status === 'pending') : undefined
    },
    answerAttention: async input => await dsh.answerAttention(input),
    subscribeReset: listener => ctx.on('connection/reset', listener),
    pollMs: 5000,
  })
  const notificationsSource = createNotificationsSource({
    list: async () => await dsh.notificationList(),
    pollMs: 5000,
  })
  const connectionsSource = createConnectionsSource({
    list: async () => await dsh.connectionList(),
    add: async input => await dsh.connectionAdd(input),
    update: async input => await dsh.connectionUpdate(input),
    test: async id => await dsh.connectionTest(id),
    remove: async id => await dsh.connectionRemove(id),
    deleteInfo: async id => await dsh.connectionDeleteInfo(id),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  const mappingsSource = createMappingsSource({
    projects: async () => await dsh.projectList(),
    mappings: async () => await dsh.mappingList(),
    connections: async () => await dsh.connectionList(),
    set: async input => await dsh.mappingSet(input),
    remove: async input => await dsh.mappingRemove(input),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  const triggersSource = createTriggersSource({
    sources: async () => await dsh.sourceList(),
    connections: async () => await dsh.connectionList(),
    threads: async () => await dsh.threadList(),
    add: async input => await dsh.sourceAdd(input),
    update: async input => await dsh.sourceUpdate(input),
    poll: async input => await dsh.sourcePoll(input),
    remove: async input => await dsh.sourceRemove(input),
    triggersOf: async input => await dsh.triggerList(input),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  const evalsSource = createEvalsSource({
    list: async input => await dsh.evalList(input),
    connections: async () => await dsh.connectionList(),
    subscribeReset: listener => ctx.on('connection/reset', listener),
    pollMs: 5000,
  })
  const stewardSource = createStewardSource({
    status: async () => (typeof dsh.stewardStatus === 'function'
      ? await dsh.stewardStatus()
      : { ok: false }),
    readPrompt: async promptId => (typeof dsh.stewardPrompt === 'function'
      ? await dsh.stewardPrompt({ promptId })
      : { ok: false }),
    // The status rides a faster cadence than the feeds: the busy dot is the
    // steward's live "working or resting" signal.
    pollMs: 3000,
  })
  const uiSettingsSource = createUiSettingsSource({
    read: async () => await dsh.uiSettings(),
    save: async input => await dsh.uiSettingsUpdate(input),
    onTitleApplied: applyTitle,
  })
  const imSettingsSource = createImSettingsSource({
    read: async () => (typeof dsh.imSettings === 'function' ? await dsh.imSettings() : { ok: false }),
    save: async input => (typeof dsh.imSettingsUpdate === 'function' ? await dsh.imSettingsUpdate(input) : { ok: false }),
    testSend: async input => (typeof dsh.imTestSend === 'function' ? await dsh.imTestSend(input) : { ok: false }),
  })
  const flowSource = createFlowSource({
    list: async () => await dsh.flowList(),
    add: async input => await dsh.flowAdd(input),
    update: async input => await dsh.flowUpdate(input),
    remove: async input => await dsh.flowRemove(input),
    ...(typeof dsh.flowPresetApply === 'function'
      ? { applyPreset: async input => await dsh.flowPresetApply(input) }
      : {}),
    ...(typeof dsh.flowImportPlaybook === 'function'
      ? { importPlaybook: async input => await dsh.flowImportPlaybook(input) }
      : {}),
    ...(typeof dsh.flowSyncPlaybook === 'function'
      ? { syncPlaybook: async input => await dsh.flowSyncPlaybook(input) }
      : {}),
    ...(typeof dsh.skillCatalog === 'function'
      ? { skillCatalog: async () => await dsh.skillCatalog() }
      : {}),
    ...(typeof dsh.agentKindOptions === 'function'
      ? { agentKindOptions: async input => await dsh.agentKindOptions(input) }
      : {}),
    ...(typeof dsh.modelOptions === 'function'
      ? { modelOptions: async () => await dsh.modelOptions() }
      : {}),
    ...(typeof dsh.teamConfigExportYaml === 'function'
      ? { exportYaml: async () => await dsh.teamConfigExportYaml() }
      : {}),
    ...(typeof dsh.teamConfigImportYaml === 'function'
      ? { importYaml: async input => await dsh.teamConfigImportYaml(input) }
      : {}),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  const teamConfigSource = createTeamConfigSource({
    ...(typeof dsh.teamConfigStatus === 'function'
      ? { readStatus: async () => await dsh.teamConfigStatus() }
      : {}),
    ...(typeof dsh.teamConfigReload === 'function'
      ? { reload: async () => await dsh.teamConfigReload() }
      : {}),
    subscribeReset: listener => ctx.on('connection/reset', listener),
    onInvalidate: () => {
      flowSource.invalidate()
    },
    pollMs: 2000,
  })
  const policySource = createPolicySource({
    list: async () => await dsh.policyList(),
    update: async input => await dsh.policyUpdate(input),
  })
  // One main-slot occupant: the tabbed panel reads every source through one
  // injection. Each source subscribes (and starts polling) only while its tab
  // renders, so idle tabs cost no reads.
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({
      ...boardSource,
      ...notificationsSource,
      ...connectionsSource,
      ...mappingsSource,
      ...triggersSource,
      ...evalsSource,
      ...stewardSource,
      ...uiSettingsSource,
      ...imSettingsSource,
      ...flowSource,
      ...teamConfigSource,
      ...policySource,
      // The sources each carry a `hooks` seat; the merge keeps all of them.
      hooks: {
        ...boardSource.hooks,
        ...notificationsSource.hooks,
        ...connectionsSource.hooks,
        ...mappingsSource.hooks,
        ...triggersSource.hooks,
        ...evalsSource.hooks,
        ...stewardSource.hooks,
        ...uiSettingsSource.hooks,
        ...imSettingsSource.hooks,
        ...flowSource.hooks,
        ...teamConfigSource.hooks,
        ...policySource.hooks,
      },
    }),
  }, ManagerPage)), 'dsh-manager: manager panel')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    locale: NS,
    label: () => ctx.locale.bind(NS)('app.title'),
    inject: () => ({ ...notificationsSource }),
  }, BoardNavIcon)), 'dsh-manager: manager navigation')
}
