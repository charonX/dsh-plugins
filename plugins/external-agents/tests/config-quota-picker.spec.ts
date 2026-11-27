import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalAgentConfigStore } from '../src/config-store.ts'
import {
  ExternalQuotaStore,
  parseAgyUsageOutput,
  parseClaudeAuthStatus,
  parseClaudeRateLimitInfo,
} from '../src/quota-store.ts'
import {
  filterExternalModels,
  formatCustomModelsText,
  parseCustomModelsText,
  resolveActiveModelAndEffort,
} from '../src/client/model-picker-core.ts'

describe('ExternalAgentConfigStore & ExternalQuotaStore', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('persists defaultAgent, per-CLI defaults, and merges seed + user custom models', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-cfg-'))
    dirs.push(dir)
    const configPath = join(dir, 'config.json')

    const store1 = new ExternalAgentConfigStore(configPath, {
      agy: [{ id: 'seed-model', name: 'Seed Model' }],
    })
    expect(store1.getDefaultAgent()).toBe('native')
    expect(store1.getCustomModels('agy')).toEqual([{ id: 'seed-model', name: 'Seed Model' }])

    store1.update({
      defaultAgent: 'agy',
      agentId: 'agy',
      settings: {
        defaultModel: 'gemini-4-neon',
        defaultReasoningEffort: 'high',
        customModels: [{ id: 'user-model', name: 'User Model' }, { id: 'seed-model', name: 'Seed Override' }],
      },
    })

    const store2 = new ExternalAgentConfigStore(configPath, {
      agy: [{ id: 'seed-model', name: 'Seed Model' }],
    })
    expect(store2.getDefaultAgent()).toBe('agy')
    expect(store2.getAgentSettings('agy')).toEqual({
      defaultModel: 'gemini-4-neon',
      defaultReasoningEffort: 'high',
      customModels: [{ id: 'user-model', name: 'User Model' }, { id: 'seed-model', name: 'Seed Override' }],
    })
    expect(store2.getCustomModels('agy')).toEqual([
      { id: 'user-model', name: 'User Model' },
      { id: 'seed-model', name: 'Seed Override' },
    ])
  })

  it('parses agy -p "/usage" --output-format json output accurately and persists quota snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-quota-'))
    dirs.push(dir)
    const quotaPath = join(dir, 'quotas.json')

    const sample = JSON.stringify({
      status: 'SUCCESS',
      num_turns: 0,
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.76966,
                  reset_time: '2026-12-03T07:01:55Z',
                },
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 0.15,
                  reset_time: '2026-11-27T06:04:59Z',
                },
              ],
            },
          ],
        },
      },
    })

    const parsed = parseAgyUsageOutput(sample, '2026-11-27T02:00:00.000Z')
    expect(parsed).toBeDefined()
    expect(parsed?.status).toBe('ok')
    expect(parsed?.source).toBe('active_cli')
    expect(parsed?.groups).toHaveLength(1)
    expect(parsed?.groups?.[0]?.buckets[0]).toMatchObject({
      id: 'gemini-weekly',
      window: 'weekly',
      remainingPercent: 77,
      usedPercent: 23,
      status: 'allowed',
      resetAt: '2026-12-03T07:01:55.000Z',
    })
    expect(parsed?.groups?.[0]?.buckets[1]).toMatchObject({
      id: 'gemini-5h',
      window: '5h',
      remainingPercent: 15,
      status: 'warning',
    })

    const qStore1 = new ExternalQuotaStore(quotaPath)
    qStore1.set('agy', parsed!)
    const qStore2 = new ExternalQuotaStore(quotaPath)
    expect(qStore2.get('agy')).toEqual(parsed)
  })

  it('parses Claude rate_limit_info and non-secret claude auth status', () => {
    const quota = parseClaudeRateLimitInfo({
      status: 'rejected',
      rateLimitType: 'five_hour',
      utilization: 1,
      resetsAt: 1_800_000_000,
    }, '2026-11-27T02:00:00.000Z')
    expect(quota?.groups?.[0]?.buckets[0]).toMatchObject({
      id: 'claude-5h',
      remainingPercent: 0,
      usedPercent: 100,
      status: 'rejected',
    })

    const auth = parseClaudeAuthStatus(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      email: 'should-not-be-exposed@example.com',
    }))
    expect(auth).toEqual({
      authenticated: true,
      method: 'claude.ai',
      plan: 'max',
      summary: 'Logged in · max',
    })
  })
})

describe('Single-popover model & effort helpers', () => {
  it('filters models by prefix before substring', () => {
    const models = [
      { id: 'default', name: 'Default' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { id: 'claude-sonnet', name: 'Claude Sonnet' },
    ]
    expect(filterExternalModels(models, 'gem').map(m => m.id)).toEqual(['gemini-3.8-flash', 'gemini-4-neon'])
    expect(filterExternalModels(models, 'neon').map(m => m.id)).toEqual(['gemini-4-neon'])
  })

  it('resolves session override over settings default over descriptor default', () => {
    const descriptor = {
      id: 'agy' as const,
      label: 'Antigravity',
      command: 'agy',
      available: true,
      defaultModel: 'default',
      models: [
        { id: 'default', name: 'Default' },
        { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      ],
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      },
      permissionModes: [],
      commands: [],
    }
    const fromSettings = resolveActiveModelAndEffort(descriptor, null, {
      defaultModel: 'gemini-4-neon',
      defaultReasoningEffort: 'low',
    })
    expect(fromSettings.modelId).toBe('gemini-4-neon')
    expect(fromSettings.modelLabel).toBe('Gemini 4 Neon')
    expect(fromSettings.effortId).toBe('low')
    expect(fromSettings.effortLabel).toBe('Low')

    const fromSession = resolveActiveModelAndEffort(
      descriptor,
      {
        sessionId: 's1',
        agentId: 'agy',
        locked: false,
        running: false,
        selectedExternalModel: { model: 'default', reasoningEffort: 'high' },
      },
      { defaultModel: 'gemini-4-neon', defaultReasoningEffort: 'low' },
    )
    expect(fromSession.modelId).toBe('default')
    expect(fromSession.effortId).toBe('high')
  })

  it('parses and formats custom model lists cleanly', () => {
    const parsed = parseCustomModelsText('default\ngemini-4-neon|Gemini 4 Neon, custom-a\ncustom-a')
    expect(parsed).toEqual([
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { id: 'custom-a', name: 'custom-a' },
    ])
    expect(formatCustomModelsText(parsed)).toBe('gemini-4-neon|Gemini 4 Neon\ncustom-a')
  })
})
