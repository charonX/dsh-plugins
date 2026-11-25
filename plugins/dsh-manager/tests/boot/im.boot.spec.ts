/**
 * Boot-tier integration spec for DshManagerIm: verifies optional `ctx.dshIm`
 * discovery, default attention-only fan-out, echo suppression for `im-tool`
 * origin, and global DSH tools (`dsh_manager_*`) interacting with board/executor.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../src/index.ts'
import { askAttention } from '../../src/attention/attention-core.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const home = await mkdtemp(join(tmpdir(), 'dsh-im-boot-'))
const feishuHome = await mkdtemp(join(tmpdir(), 'dsh-im-feishu-'))
const execCwd = await mkdtemp(join(tmpdir(), 'dsh-im-cwd-'))

const overlayPath = join(home, 'im.patch.yml')
await writeFile(overlayPath, [
  '- insert:',
  '    - id: dsh-manager',
  '      name: "@charonx/dsh-manager"',
  '      config:',
  '        steward:',
  '          tickMs: 3600000',
  '        executor:',
  '          tickMs: 3600000',
  `          cwd: ${JSON.stringify(execCwd)}`,
  '',
].join('\n'))

async function waitUntilService(ctx: Context, name: string, timeoutMs = 30_000): Promise<void> {
  const reflect = (ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }).reflect
  const deadline = Date.now() + timeoutMs
  while (reflect.get(name, true) === undefined) {
    if (Date.now() > deadline) throw new Error(`service ${name} did not become ready within ${timeoutMs}ms`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

let bootCtx: Context | undefined
afterAll(async () => {
  await bootCtx?.fiber.dispose()
  await rm(home, { recursive: true, force: true })
  await rm(feishuHome, { recursive: true, force: true })
  await rm(execCwd, { recursive: true, force: true })
})

test('dshIm dynamic discovery, default approval-only push, and global IM tools', async () => {
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
  })
  bootCtx = ctx
  await waitUntilService(ctx, 'dshManagerIm')
  await waitUntilService(ctx, 'dshManagerExecutor')
  const initial = await ctx.dshManagerIm.imSettings()
  expect(initial.available).toBe(false)
  expect(initial.settings.notifyAttention).toBe(true)
  expect(initial.settings.notifyProgress).toBe(false)
  expect('notifyBriefing' in initial.settings).toBe(false)

  const sent: { botId: string; targetId: string; text: string }[] = []
  ctx.provide('dshIm', {
    listBots: vi.fn().mockResolvedValue([{ botId: 'bot-wx-1', channel: 'weixin' }]),
    listTargets: vi.fn().mockResolvedValue([{ targetId: 'owner', name: 'My WeChat', kind: 'user' }]),
    send: vi.fn().mockImplementation(async (botId: string, targetId: string, text: string) => {
      sent.push({ botId, targetId, text })
      return { sent: true }
    }),
  })

  const configured = await ctx.dshManagerIm.imSettingsUpdate({
    enabled: true,
    botId: 'bot-wx-1',
    targetId: 'owner',
  })
  expect(configured.available).toBe(true)
  expect(configured.bots[0]?.targets[0]?.targetId).toBe('owner')

  const testResult = await ctx.dshManagerIm.imTestSend()
  expect(testResult).toEqual({ sent: true })
  expect(sent).toHaveLength(1)

  // Default scope pushes attention, skips progress.
  await ctx.dshManagerNotifications.notify({
    id: 'prog-1', kind: 'progress', attentionId: '', ticketId: '', title: 'Stage 1 done', at: 101,
  })
  expect(sent).toHaveLength(1)

  // Create a manual ticket via the global DSH tool.
  const createTool = ctx.tools.get('dsh_manager_create_ticket')
  expect(createTool).toBeDefined()
  const created = await createTool!.execute({ title: 'WeChat task', description: 'check auth flow' }, {} as never)
  expect(created).toMatchObject({ submitted: true })

  // Raise one pending policy attention and verify it pushes to WeChat.
  const att = await askAttention(ctx.dshManagerBoard.attentionStore(), {
    ticketId: '',
    dispatchId: 'steward',
    kind: 'policy',
    question: 'allow relaxing external comment approval?',
    action: { category: 'policy-change', tool: 'propose_policy', payload: { change: 'add-preference', statement: 'prefer concise', rationale: 'test' } },
  }, Date.now())
  await ctx.dshManagerNotifications.notify({
    id: att.id,
    kind: 'attention',
    attentionId: att.id,
    ticketId: att.ticketId,
    title: att.question,
    at: att.createdAt,
    attentionKind: att.kind,
  })
  expect(sent).toHaveLength(2)
  expect(sent[1]?.text).toContain(att.id)

  // Inspect board via tool, then approve via tool; enable progress first to prove im-tool suppresses echo.
  await ctx.dshManagerIm.imSettingsUpdate({ notifyProgress: true })
  const summaryTool = ctx.tools.get('dsh_manager_board_summary')
  const summaryResult = await summaryTool!.execute({}, {} as never) as { pendingAttentions: { id: string }[] }
  expect(summaryResult.pendingAttentions.some(item => item.id === att.id)).toBe(true)

  const answerTool = ctx.tools.get('dsh_manager_answer_attention')
  const answerResult = await answerTool!.execute({ attentionId: att.id, action: 'approve' }, {} as never)
  expect(answerResult).toEqual({ ok: true, attentionId: att.id, ticketId: '', answer: 'approved' })
  // `origin: 'im-tool'` suppresses sending duplicate confirmation to IM.
  expect(sent).toHaveLength(2)

  // GUI feed still never includes 'progress' notifications.
  const guiFeed = (await ctx.dshManagerNotifications.notificationList()).notifications
  expect(guiFeed.some((entry: { kind: string }) => entry.kind === 'progress')).toBe(false)
}, 120_000)

test('direct hand-off mints todo ticket with session & projectId and notifies back to origin Feishu topic in Markdown', async () => {
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: feishuHome,
  })
  try {
    await waitUntilService(ctx, 'dshManagerIm')
    await waitUntilService(ctx, 'dshManagerExecutor')
    const sessionDeliveries: { sessionId: string; text: string; format?: string | undefined }[] = []
    const staticSends: { botId: string; targetId: string; text: string; format?: string | undefined }[] = []

    const ws = await ctx.workspaceRegistry.create(execCwd, 'Project Demo')
    const feishuTopicSessionId = 'feishu-topic-session-1'

    ctx.provide('dshIm', {
      listBots: vi.fn().mockResolvedValue([
        { botId: 'bot-feishu-1', channel: 'feishu' },
        { botId: 'bot-wx-1', channel: 'weixin' },
      ]),
      listTargets: vi.fn().mockImplementation(async (botId: string) => (
        botId === 'bot-feishu-1'
          ? [{ targetId: 'feishu-grp', name: 'Dev Group', kind: 'group' }]
          : [{ targetId: 'owner', name: 'My WeChat', kind: 'user' }]
      )),
      send: vi.fn().mockImplementation(async (botId: string, targetId: string, text: string, options?: { format?: string }) => {
        staticSends.push({ botId, targetId, text, format: options?.format })
        return { sent: true }
      }),
      describeConversation: vi.fn().mockImplementation(async (sessionId: string) => (
        sessionId === feishuTopicSessionId
          ? {
              botId: 'bot-feishu-1',
              channel: 'feishu',
              conversationKey: 'group:oc_demo:managed:om_root_1',
              chatType: 'thread',
              chatId: 'oc_demo',
              threadId: null,
            }
          : null
      )),
      deliverSessionText: vi.fn().mockImplementation(async (sessionId: string, text: string, options?: { format?: string }) => {
        sessionDeliveries.push({ sessionId, text, format: options?.format })
        return { sent: true }
      }),
    })

    // Direct tool hand-off from Feishu session: auto-resolves projectId and skips Steward inbox wait.
    const createTool = ctx.tools.get('dsh_manager_create_ticket')
    expect(createTool).toBeDefined()
    const handoffResult = await createTool!.execute({
      title: 'Implement health endpoint',
      description: 'Add /healthz route with JSON response',
      scope: 'Only touch health route handler and unit test',
      acceptanceCriteria: 'GET /healthz returns 200 and unit tests pass',
    }, {
      agent: {
        id: feishuTopicSessionId,
        session: { header: { cwd: ws.path } },
      },
    } as never) as { submitted: boolean; mode: string; ticketId: string; projectId?: string }

    expect(handoffResult.submitted).toBe(true)
    expect(handoffResult.mode).toBe('direct')
    expect(handoffResult.projectId).toBe(ws.id)

    const record = ctx.dshManagerBoard.ticketRecord(handoffResult.ticketId)
    expect(record).toMatchObject({
      state: 'todo',
      projectId: ws.id,
      handoffSessionId: feishuTopicSessionId,
      acceptanceCriteria: 'GET /healthz returns 200 and unit tests pass',
      mandate: { strength: 'explicit', scope: 'Only touch health route handler and unit test' },
    })

    // Global target = WeChat (plain) while origin = Feishu topic (markdown): both receive formatted notifications without Feishu spam.
    await ctx.dshManagerIm.imSettingsUpdate({ enabled: true, botId: 'bot-wx-1', targetId: 'owner', notifyProgress: true })
    const att = await askAttention(ctx.dshManagerBoard.attentionStore(), {
      ticketId: handoffResult.ticketId,
      dispatchId: 'dispatch-1',
      kind: 'question',
      question: 'Should /healthz include build sha?',
    }, Date.now())
    await ctx.dshManagerNotifications.notify({
      id: att.id,
      kind: 'attention',
      attentionId: att.id,
      ticketId: handoffResult.ticketId,
      title: att.question,
      at: att.createdAt,
      attentionKind: att.kind,
    })

    expect(sessionDeliveries).toHaveLength(1)
    expect(sessionDeliveries[0]).toMatchObject({
      sessionId: feishuTopicSessionId,
      format: 'markdown',
    })
    expect(sessionDeliveries[0]!.text).toContain('**[中控台 · 待回复]**')
    expect(staticSends).toHaveLength(1)
    expect(staticSends[0]).toMatchObject({ botId: 'bot-wx-1', targetId: 'owner', format: 'plain' })

    // Switching global target to the SAME Feishu bot group deduplicates main-feed spam once origin topic received it.
    await ctx.dshManagerIm.imSettingsUpdate({ enabled: true, botId: 'bot-feishu-1', targetId: 'feishu-grp', notifyProgress: true })
    await ctx.dshManagerBoard.finishTicket(handoffResult.ticketId, Date.now())
    expect(sessionDeliveries).toHaveLength(2)
    expect(sessionDeliveries[1]!.format).toBe('markdown')
    expect(staticSends).toHaveLength(1)
  } finally {
    await ctx.fiber.dispose()
  }
}, 120_000)
