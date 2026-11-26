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
    await expect(page.locator('#dsh-team-view-flows')).toBeVisible()
    await expect(page.locator('#dsh-team-view-skills')).toBeVisible()
    await expect(page.locator('#dsh-team-view-crew')).toHaveCount(0)
    await expect(page.locator('#dsh-team-view-prompt')).toHaveCount(0)
    await expect(page.locator('#dsh-team-audit')).toHaveCount(0)
    await page.locator('#dsh-team-view-skills').click()
    await expect(page.locator('#dsh-team-skills')).toBeVisible()

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

  test('Team & Flows tab supports creating generic Flows, topology inspector, persistence, and clean removal', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    await openManager(page)
    await page.locator('#dsh-manager-tab-team').click()
    await expect(page.locator('#dsh-team-workbench')).toBeVisible()

    // 1. Create a Flow IR manually (`New flow`) and inspect it on Topology + List views.
    await page.getByRole('button', { name: /新建流程|New flow/ }).click()
    const flowDialog = page.getByRole('dialog')
    await expect(flowDialog).toBeVisible()

    await flowDialog.locator('input').first().fill('E2E-知识创作流')
    await flowDialog.locator('textarea').first().fill('撰写技术文章或领域知识笔记（无需 git worktree）')
    await selectDshMenuOption(page, flowDialog.locator('[data-select-control]').first(), /in-place/)

    await flowDialog.getByRole('button', { name: /保存流程|Save flow/ }).click()
    await expect(flowDialog).toBeHidden()
    await expect(page.locator('#dsh-team-workbench')).toContainText('E2E-知识创作流')

    // Verify List mode + Topology inspector
    await page.locator('#dsh-team-workbench-mode-list').click()
    await expect(page.locator('#dsh-team-flows')).toContainText('E2E-知识创作流')

    // 2. Reload the whole app and confirm storage persistence in team-config.yaml.
    await openManager(page)
    await page.locator('#dsh-manager-tab-team').click()
    await page.locator('#dsh-team-workbench-mode-list').click()
    await expect(page.locator('#dsh-team-flows')).toContainText('E2E-知识创作流')

    // 3. Clean up the created flow.
    const flowCard = page.locator('#dsh-team-flows article', { hasText: 'E2E-知识创作流' }).first()
    await flowCard.getByRole('button', { name: /^(删除|Remove)$/ }).click()
    await expect(page.locator('#dsh-team-flows')).not.toContainText('E2E-知识创作流')

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

  test('Flow presets and one-shot Playbook compiler compile into Flow IR and show Skill catalog', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    await openManager(page)
    await page.locator('#dsh-manager-tab-team').click()
    await expect(page.locator('#dsh-manager-panel-team')).toBeVisible()

    // Fresh DSH_HOME automatically compiles and displays the default Playbook flows.
    await page.locator('#dsh-team-workbench-mode-list').click()
    await expect(page.locator('#dsh-team-flows')).toContainText(/通用功能开发/)
    await expect(page.locator('#dsh-team-flows')).toContainText(/通用缺陷修复/)
    await expect(page.locator('#dsh-team-flows')).toContainText(/知识创作/)
    await expect(page.locator('#dsh-team-flows')).toContainText(/架构重构/)
    await expect(page.locator('#dsh-team-flows')).toContainText('/writing')

    // Apply preset from discovered Playbook catalog (creates an editable `(2)` copy).
    await page.getByRole('button', { name: /从预设复制|Copy from preset/ }).click()
    const presetDialog = page.getByRole('dialog')
    await expect(presetDialog).toBeVisible()
    await expect(presetDialog).toContainText(/知识创作|Knowledge/)
    await presetDialog.getByRole('button', { name: /一键复制为流程|Copy as flow/ }).last().click()
    await expect(presetDialog).toBeHidden()

    await expect(page.locator('#dsh-team-flows')).toContainText(/\(2\)/)

    // Import & compile a Markdown Playbook once into Flow IR
    await page.getByRole('button', { name: /从 Playbook 识别|Import Playbook/ }).click()
    const playbookDialog = page.getByRole('dialog')
    await expect(playbookDialog).toBeVisible()
    await page.locator('#dsh-playbook-kind-markdown').click()
    await playbookDialog.locator('input').first().fill('e2e-poteto-test')
    await playbookDialog.locator('textarea').first().fill([
      '### E2E Poteto Flow',
      '1. Reproduce & check read-only via `verify`.',
      '2. Implement minimal fix via `tdd`.',
      '3. Independent review via `code-review`.',
    ].join('\n'))
    await playbookDialog.getByRole('button', { name: /识别并缓存为流程|Compile & cache/ }).click()
    await expect(playbookDialog).toBeHidden()

    await expect(page.locator('#dsh-team-flows')).toContainText('E2E Poteto Flow')
    await expect(page.locator('#dsh-team-flows')).toContainText(/已缓存|Cached/)

    const evidenceDir = process.env.DSH_EVIDENCE_DIR
    if (evidenceDir !== undefined && evidenceDir !== '') {
      await page.locator('#dsh-team-workbench-mode-graph').click()
      await page.waitForTimeout(300)
      // Inspector + editor: right-panel padding and the widened dialog.
      const nodeButtons = page.locator('#dsh-team-flows button[title]')
      if (await nodeButtons.count() > 1) {
        await nodeButtons.nth(1).click()
        await page.waitForTimeout(250)
        await page.screenshot({ path: `${evidenceDir}/team-inspector-light.png`, fullPage: false })
        await page.getByRole('button', { name: /^(Edit|编辑)$/ }).first().click()
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${evidenceDir}/team-flow-editor-light.png`, fullPage: false })
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
      }
      await page.emulateMedia({ colorScheme: 'light' })
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${evidenceDir}/team-flows-light.png`, fullPage: false })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${evidenceDir}/team-flows-dark.png`, fullPage: false })

      await page.locator('#dsh-team-view-skills').click()
      await expect(page.locator('#dsh-team-skills')).toBeVisible()
      await page.emulateMedia({ colorScheme: 'light' })
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${evidenceDir}/team-skills-light.png`, fullPage: false })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${evidenceDir}/team-skills-dark.png`, fullPage: false })

      await page.locator('#dsh-team-view-flows').click()
      await page.locator('#dsh-team-workbench-mode-list').click()
    }

    // Clean up only the E2E-added flows, keeping auto-seeded defaults intact.
    for (const label of ['E2E Poteto Flow', '(2)']) {
      const card = page.locator('#dsh-team-flows article', { hasText: label }).first()
      if ((await card.count()) > 0) {
        await card.getByRole('button', { name: /^(删除|Remove)$/ }).click()
      }
    }

    expect(pageErrors).toEqual([])
  })
})
