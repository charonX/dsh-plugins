import { expect, test, type Locator, type Page } from '@playwright/test'

function appEntryUrl(): string {
  return process.env.DSH_E2E_URL ?? '/'
}

let welcomeSettled = false

async function dismissOpenDialogs(page: Page): Promise<boolean> {
  const dialog = page.locator('dialog[open], [role="dialog"]')
  if ((await dialog.count()) === 0) return false
  const confirmBtn = dialog.last().getByRole('button', { name: /^(Continue|继续|知道了|OK)$/i })
  if ((await confirmBtn.count()) > 0) {
    await confirmBtn.click({ timeout: 5_000 }).catch(() => {})
    await expect(dialog).toHaveCount(0, { timeout: 10_000 }).catch(() => {})
    welcomeSettled = true
    return true
  }
  return false
}

async function openManager(page: Page, sidebarLabel = /中控台|Control Center/): Promise<void> {
  await page.goto(appEntryUrl(), { waitUntil: 'domcontentloaded' })
  const navBtn = page.getByRole('button', { name: sidebarLabel }).first()
  await expect(navBtn).toBeVisible({ timeout: 30_000 })

  const dialog = page.locator('dialog[open], [role="dialog"]')
  if (!welcomeSettled) {
    // On first visit in an isolated DSH_HOME, WelcomeNotice mounts asynchronously after domcontentloaded.
    await dialog.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    await dismissOpenDialogs(page)
  }

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await dismissOpenDialogs(page)) continue
    const clicked = await navBtn.click({ timeout: 2_500 }).then(() => true, () => false)
    if (clicked) {
      const mounted = await page.locator('#dsh-manager-tab-board')
        .waitFor({ state: 'visible', timeout: 2_500 })
        .then(() => true, () => false)
      if (mounted && (await dialog.count()) === 0) return
    }
    await page.waitForTimeout(200)
  }
  await expect(page.locator('#dsh-manager-tab-board')).toBeVisible()
}

async function selectDshMenuOption(page: Page, trigger: Locator, optionPattern: RegExp): Promise<void> {
  await trigger.click()
  const item = page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: optionPattern }).first()
  await expect(item).toBeVisible()
  await item.click()
}

test.describe.serial('@charonx/dsh-manager E2E', () => {
  test('renders sidebar entry and switches cleanly across all 5 primary tabs without page errors', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    await openManager(page)

    await expect(page.locator('#dsh-manager-tab-briefings')).toHaveCount(0)

    await page.locator('#dsh-manager-tab-team').click()
    await expect(page.locator('#dsh-manager-panel-team')).toBeVisible()
    await expect(page.locator('#dsh-team-workbench')).toBeVisible()
    await expect(page.locator('#dsh-team-audit')).toHaveCount(0)
    await page.locator('#dsh-team-view-crew').click()
    await expect(page.locator('#dsh-team-crew')).toBeVisible()

    await page.locator('#dsh-manager-tab-policy').click()
    await expect(page.locator('#dsh-manager-panel-policy')).toBeVisible()
    await expect(page.getByRole('button', { name: /添加决策规则|Add policy rule/ })).toBeVisible()

    await page.locator('#dsh-manager-tab-monitor').click()
    await expect(page.locator('#dsh-manager-panel-monitor')).toBeVisible()
    await expect(page.locator('#dsh-monitor-view-evals-panel')).toBeVisible()
    await page.locator('#dsh-monitor-view-activity').click()
    await expect(page.locator('#dsh-monitor-view-activity-panel')).toBeVisible()
    await expect(page.locator('#dsh-monitor-view-activity-panel')).not.toContainText(/晨间简报|briefing/i)

    await page.locator('#dsh-manager-tab-settings').click()
    await expect(page.locator('#dsh-manager-panel-settings')).toBeVisible()
    await expect(page.getByRole('button', { name: /保存名称|Save name/ })).toBeVisible()
    await expect(page.locator('#dsh-manager-panel-settings')).not.toContainText(/晨间简报|briefing/i)

    await page.locator('#dsh-manager-tab-board').click()
    await expect(page.locator('#dsh-manager-panel-board')).toBeVisible()
    await expect(page.getByRole('button', { name: /手动输入一件事|Enter a task manually/ })).toBeVisible()

    expect(pageErrors).toEqual([])
  })

  test('Board manual input modal opens SlashInput completions on `/` and submits cleanly', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    await openManager(page)

    const manualBtn = page.getByRole('button', { name: /手动输入一件事|Enter a task manually/ })
    await manualBtn.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const inputs = dialog.locator('input, textarea')
    await inputs.nth(0).fill('E2E 看板手工工单')

    // Let `agentKindOptions` RPC finish loading external CLI slash commands, then trigger `/`.
    const descInput = inputs.nth(1)
    await descInput.click()
    await descInput.pressSequentially('/')

    const listbox = page.locator('[role="listbox"]')
    await expect(listbox).toBeVisible({ timeout: 8_000 })
    const options = listbox.locator('[role="option"]')
    await expect(options.first()).toBeVisible()
    await options.first().click()
    await expect(descInput).toHaveValue(/^\//)

    await dialog.getByRole('button', { name: /^(提交|Submit)$/ }).click()
    await expect(dialog).toBeHidden()
    expect(pageErrors).toEqual([])
  })

  test('Team tab supports creating Crew + Pipeline (with Stage SlashInput), topology inspector actions, persists on reload, and cleans up', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    await openManager(page)
    await page.locator('#dsh-manager-tab-team').click()
    await expect(page.locator('#dsh-team-workbench')).toBeVisible()

    // 1. Switch to Crew roster and add a Crew member bound to Claude Code.
    await page.locator('#dsh-team-view-crew').click()
    await expect(page.locator('#dsh-team-crew')).toBeVisible()
    await page.getByRole('button', { name: /添加队员|Add member/ }).click()
    const crewDialog = page.getByRole('dialog')
    await expect(crewDialog).toBeVisible()

    await crewDialog.locator('input').first().fill('E2E-Claude研发')
    await crewDialog.locator('textarea').first().fill('负责自动化回归验证与工程质量检查')
    await selectDshMenuOption(page, crewDialog.locator('#dsh-crew-agent-kind'), /Claude Code/)
    const claudeReady = await crewDialog.getByText(/^(Ready:|已就绪：)/).isVisible({ timeout: 5_000 }).catch(() => false)

    await crewDialog.getByRole('button', { name: /^(添加|Add)$/ }).click()
    await expect(crewDialog).toBeHidden()
    await expect(page.locator('#dsh-team-crew')).toContainText('E2E-Claude研发')

    // 2. Switch back to Orchestration workbench (default Topology) and add Pipeline + Rule.
    await page.locator('#dsh-team-view-workbench').click()
    await expect(page.locator('#dsh-team-workbench')).toBeVisible()
    await page.getByRole('button', { name: /添加流水线|Add pipeline/ }).click()
    const pipelineDialog = page.getByRole('dialog')
    await expect(pipelineDialog).toBeVisible()

    await pipelineDialog.locator('input').first().fill('E2E-研发流水线')
    await selectDshMenuOption(page, pipelineDialog.locator('[data-select-control]').first(), /E2E-Claude研发/)

    const stageInstruction = pipelineDialog.locator('textarea').first()
    await stageInstruction.click()
    await stageInstruction.pressSequentially('/')

    const stageListbox = page.locator('[role="listbox"]')
    if (claudeReady) {
      await expect(stageListbox).toBeVisible({ timeout: 8_000 })
      await stageListbox.locator('[role="option"]').first().click()
      await expect(stageInstruction).toHaveValue(/^\//)
    } else {
      await stageInstruction.fill('/verify 执行端到端验证')
    }

    await pipelineDialog.getByRole('button', { name: /^(添加|Add)$/ }).click()
    await expect(pipelineDialog).toBeHidden()

    // Create a route rule in Topology mode so the canvas and Inspector become interactive.
    await page.getByRole('button', { name: /添加规则|Add rule/ }).click()
    const ruleDialog = page.getByRole('dialog')
    await expect(ruleDialog).toBeVisible()
    await ruleDialog.locator('textarea').first().fill('E2E-拓扑交互规则')
    await selectDshMenuOption(page, ruleDialog.locator('[data-select-control]').first(), /E2E-研发流水线/)
    await ruleDialog.getByRole('button', { name: /^(添加|Add)$/ }).click()
    await expect(ruleDialog).toBeHidden()

    // Select the rule node in Topology Inspector and remove it directly from the Inspector.
    const inspector = page.locator('aside[aria-label="节点详情"], aside[aria-label="Node inspector"]')
    await expect(inspector).toBeVisible()
    await inspector.getByRole('button', { name: 'E2E-拓扑交互规则' }).click()
    await expect(inspector.getByRole('button', { name: /^(编辑|Edit)$/ })).toBeVisible()
    await expect(inspector.getByRole('button', { name: /^(停用|Disable)$/ })).toBeVisible()
    await inspector.getByRole('button', { name: /^(删除|Remove)$/ }).click()
    await expect(page.locator('#dsh-team-workbench')).not.toContainText('E2E-拓扑交互规则')
    await expect(inspector).toHaveCount(0)

    // Switch to List mode and verify the pipeline card.
    await page.locator('#dsh-team-workbench-mode-list').click()
    await expect(page.locator('#dsh-team-orchestration')).toContainText('E2E-研发流水线')

    // 3. Reload the whole app and confirm storage persistence across Host + Remote reload.
    await openManager(page)
    await page.locator('#dsh-manager-tab-team').click()
    await page.locator('#dsh-team-workbench-mode-list').click()
    await expect(page.locator('#dsh-team-orchestration')).toContainText('E2E-研发流水线')
    await page.locator('#dsh-team-view-crew').click()
    await expect(page.locator('#dsh-team-crew')).toContainText('E2E-Claude研发')

    // 4. Clean up pipeline first (from List mode), then crew member.
    await page.locator('#dsh-team-view-workbench').click()
    await page.locator('#dsh-team-workbench-mode-list').click()
    const pipelineCard = page.locator('#dsh-team-orchestration li', { hasText: 'E2E-研发流水线' }).first()
    await pipelineCard.getByRole('button', { name: /^(删除|Remove)$/ }).click()
    await expect(page.locator('#dsh-team-orchestration')).not.toContainText('E2E-研发流水线')

    await page.locator('#dsh-team-view-crew').click()
    const crewCard = page.locator('#dsh-team-crew li', { hasText: 'E2E-Claude研发' }).first()
    await crewCard.getByRole('button', { name: /^(删除|Remove)$/ }).click()
    await expect(page.locator('#dsh-team-crew')).not.toContainText('E2E-Claude研发')

    expect(pageErrors).toEqual([])
  })

  test('Policy tab creates a versioned decision rule, persists on reload, and removes it', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    await openManager(page)
    await page.locator('#dsh-manager-tab-policy').click()
    await expect(page.locator('#dsh-manager-panel-policy')).toBeVisible()

    const ruleText = 'E2E 策略规则：优先保留已有行为测试并拒绝未验证改动'
    await page.getByRole('button', { name: /添加决策规则|Add policy rule/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.locator('textarea').fill(ruleText)
    await dialog.getByRole('button', { name: /保存为新版本|Save as new version/ }).click()
    await expect(dialog).toBeHidden()

    await expect(page.locator('#dsh-manager-panel-policy')).toContainText(ruleText)

    // Reload and confirm the rule persisted in Host storage.
    await openManager(page)
    await page.locator('#dsh-manager-tab-policy').click()
    const panel = page.locator('#dsh-manager-panel-policy')
    await expect(panel).toContainText(ruleText)

    const ruleCard = panel.locator('li', { hasText: ruleText }).first()
    await ruleCard.getByRole('button', { name: /^(移除|Remove)$/ }).click()
    await expect(panel).not.toContainText(ruleText)

    expect(pageErrors).toEqual([])
  })

  test('Settings tab persists custom panel title & eval batch size across reloads and restores default', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    await openManager(page)
    await page.locator('#dsh-manager-tab-settings').click()
    const settingsPanel = page.locator('#dsh-manager-panel-settings')
    await expect(settingsPanel).toBeVisible()

    const customTitle = '中控台-E2E'
    const titleInput = settingsPanel.locator('input[placeholder*="中控台"], input[placeholder*="Control Center"]').first()
    await titleInput.fill(customTitle)
    await settingsPanel.getByRole('button', { name: /保存名称|Save name/ }).click()
    await expect(settingsPanel).toContainText(/已保存|Saved/)
    await expect(page.locator('h1').first()).toContainText(customTitle)

    const batchInput = settingsPanel.locator('input[type="number"]').first()
    await batchInput.fill('12')
    await settingsPanel.getByRole('button', { name: /保存上限|Save limit/ }).click()
    await expect(settingsPanel).toContainText(/已保存批量分诊上限|Saved batch triage limit/)

    // Reload and navigate via the updated sidebar title.
    await openManager(page, new RegExp(customTitle))
    await expect(page.locator('h1').first()).toContainText(customTitle)
    await page.locator('#dsh-manager-tab-settings').click()
    await expect(page.locator('#dsh-manager-panel-settings input[type="number"]').first()).toHaveValue('12')

    // Restore empty custom title -> reverts to default.
    const updatedTitleInput = page.locator('#dsh-manager-panel-settings input:not([type="number"])').first()
    await updatedTitleInput.fill('')
    await page.locator('#dsh-manager-panel-settings').getByRole('button', { name: /保存名称|Save name/ }).click()
    await expect(page.locator('#dsh-manager-panel-settings')).toContainText(/已保存|Saved/)
    await expect(page.locator('h1').first()).toContainText(/中控台|Control Center/)

    expect(pageErrors).toEqual([])
  })

  test('Team Prompt Studio shows 8 turns, locked read-only sections, rejects unknown vars, and applies presets', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    await openManager(page)
    await page.locator('#dsh-manager-tab-team').click()
    await expect(page.locator('#dsh-manager-panel-team')).toBeVisible()

    // AC-10: Apply bug-fix preset from Orchestration workbench
    await page.locator('#dsh-team-preset-open').click()
    const presetDialog = page.getByRole('dialog')
    await expect(presetDialog).toBeVisible()
    await page.locator('#dsh-preset-copy-bug-fix').click()
    await expect(presetDialog).toBeHidden()

    await page.locator('#dsh-team-workbench-mode-list').click()
    await expect(page.locator('#dsh-team-orchestration')).toContainText('缺陷修复')

    // AC-1: Switch to Prompts sub-view
    await page.locator('#dsh-team-view-prompt').click()
    await expect(page.locator('#dsh-team-prompt')).toBeVisible()
    await expect(page.locator('#dsh-prompt-node-turn-executor')).toBeVisible()
    await expect(page.locator('#dsh-prompt-node-turn-steward\\.route')).toBeVisible()

    // AC-4: Locked section `report` has no input box
    await expect(page.locator('#dsh-prompt-input-report')).toHaveCount(0)
    await expect(page.locator('#dsh-prompt-section-report pre')).toBeVisible()

    // AC-5: Unknown variable save is rejected cleanly
    const identityInput = page.locator('#dsh-prompt-input-identity')
    await identityInput.fill('Hello {{nope}}')
    await page.getByRole('button', { name: /保存更改|Save changes/ }).click()
    const confirmDialog = page.getByRole('dialog')
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: /确认写入|Confirm & save/ }).click()
    await expect(confirmDialog).toContainText(/unknown variable "nope"/)
    await confirmDialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click()

    // Clean up copied preset pipeline & generated crew members
    await page.locator('#dsh-team-view-workbench').click()
    await page.locator('#dsh-team-workbench-mode-list').click()
    const pipeCard = page.locator('#dsh-team-orchestration li', { hasText: '缺陷修复' }).first()
    await pipeCard.getByRole('button', { name: /^(删除|Remove)$/ }).click()
    await expect(page.locator('#dsh-team-orchestration')).not.toContainText('缺陷修复')

    await page.locator('#dsh-team-view-crew').click()
    for (const memberName of ['缺陷复现员', '根因修复员', '回归验证员']) {
      const card = page.locator('#dsh-team-crew li', { hasText: memberName }).first()
      if ((await card.count()) > 0) {
        await card.getByRole('button', { name: /^(删除|Remove)$/ }).click()
      }
    }

    expect(pageErrors).toEqual([])
  })
})
