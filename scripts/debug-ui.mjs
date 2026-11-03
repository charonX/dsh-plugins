#!/usr/bin/env node
/**
 * Drive the Skills page in a real browser and print what the link flow does.
 * Useful when "clicking does nothing" needs evidence rather than guesses.
 *
 * Usage:
 *   node scripts/debug-ui.mjs "<url-with-token>" /absolute/project/dir
 *   node scripts/debug-ui.mjs "<url-with-token>" /absolute/project/dir --agents "Claude Code,AdaL"
 *   node scripts/debug-ui.mjs "<url-with-token>" --empty-project
 *
 * The URL is the one `dsh web` prints (it carries the login token). Playwright
 * is not a dependency of this package; install it once with
 *   npm i -D playwright && npx playwright install chromium
 * or run this script from a checkout that already has Playwright.
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const url = args.shift()
const emptyProject = args.includes('--empty-project')
const agentsFlag = args.indexOf('--agents')
const extraAgents = agentsFlag === -1 ? ['Claude Code'] : (args[agentsFlag + 1] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
const project = emptyProject ? undefined : args.find((entry) => !entry.startsWith('--') && entry !== args[agentsFlag + 1] && entry !== '--agents')

if (url === undefined) {
  console.error('usage: node scripts/debug-ui.mjs "<url-with-token>" [/absolute/project] [--agents "A,B"] [--empty-project]')
  process.exit(2)
}
if (!emptyProject && (project === undefined || !project.startsWith('/'))) {
  console.error('debug-ui: pass an absolute project directory (it must already exist)')
  process.exit(2)
}
if (project !== undefined) mkdirSync(project, { recursive: true })

const require = createRequire(import.meta.url)
let chromium
try {
  ({ chromium } = require('playwright'))
} catch {
  console.error('debug-ui: playwright is not installed here. Run "npm i -D playwright && npx playwright install chromium", or run this script from a checkout that has it.')
  process.exit(2)
}

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage()
const posts = []
page.on('request', (request) => {
  if (request.url().includes('/dsh-skills-manager/')) {
    console.log(`→ ${request.method()} ${request.url()} ${request.postData() ?? ''}`)
    if (request.method() === 'POST' && request.url().endsWith('/api/links')) posts.push(request.postData())
  }
})
page.on('response', async (response) => {
  if (!response.url().includes('/dsh-skills-manager/')) return
  let body = ''
  try { body = await response.text() } catch { /* body may be consumed */ }
  console.log(`← ${response.status()} ${response.url()} ${body.slice(0, 240)}`)
})
page.on('console', (message) => {
  if (message.type() === 'warning' || message.type() === 'error') console.log(`[console:${message.type()}] ${message.text()}`)
})
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await page.getByText('技能', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  const expandAll = page.getByRole('button', { name: '全部展开' }).first()
  if (await expandAll.count() > 0) {
    await expandAll.click()
    await page.waitForTimeout(300)
  }
  const linkEntry = page.getByRole('button', { name: /关联到项目/ }).first()
  if (await linkEntry.count() === 0) {
    console.log('debug-ui: no "关联到项目" button found — is a source installed and the Skills page open?')
    process.exitCode = 1
  } else {
    await linkEntry.click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    const submit = dialog.getByRole('button', { name: '关联', exact: true })
    console.log(`submit disabled before input: ${await submit.isDisabled()}`)

    if (emptyProject) {
      await submit.click()
      await page.waitForTimeout(300)
      console.log(`inline error: ${(await dialog.getByRole('alert').allTextContents()).join(' | ') || '(none)'}`)
      console.log(`requests sent: ${posts.length} (expected 0)`)
    } else {
      await dialog.locator('input').first().fill(project)
      for (const name of extraAgents) {
        const checkboxLabel = dialog.getByText(name, { exact: true })
        if (await checkboxLabel.count() === 0) {
          console.log(`debug-ui: agent "${name}" is not in the registry list`)
          continue
        }
        await checkboxLabel.first().click()
      }
      await submit.click()
      await page.waitForTimeout(2500)
      console.log(`dialog still open: ${await dialog.isVisible().catch(() => false)}`)
      console.log(`notices: ${(await page.getByRole('status').allTextContents()).join(' | ') || '(none)'}`)
      console.log(`alerts: ${(await page.getByRole('alert').allTextContents()).join(' | ') || '(none)'}`)
      console.log(`posted bodies: ${JSON.stringify(posts)}`)
      const section = page.locator('#skills-manager-projects')
      if (await section.count() > 0) console.log(`project section visible: ${await section.isVisible()}`)
    }
    await page.screenshot({ path: 'debug-ui.png' })
    console.log('screenshot: debug-ui.png')
  }
} finally {
  await browser.close()
}
