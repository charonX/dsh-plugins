import { expect, test, type Page } from '@playwright/test'

/** Mirrors `TRANSLATION_ATTRIBUTE` in the browser half; kept literal so the
 * spec does not depend on the client module graph. */
const TRANSLATION_ATTRIBUTE = 'data-dsh-tr'

/** Marker the stub prepends, so an applied answer is recognizable in the DOM. */
const MARK = '译:'

/**
 * Serve every translate request locally and record what was asked.
 * @param page - the page under test.
 * @returns the recorded batches; each is a list of `{ id, text }`.
 */
async function stubModel(page: Page): Promise<{ id: string; text: string }[][]> {
  const batches: { id: string; text: string }[][] = []
  await page.route('**/dsh-immersive-translate/api/translate', async (route) => {
    const body = route.request().postDataJSON() as { items: { id: string; text: string }[] }
    batches.push(body.items)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: body.items.map(item => ({ id: item.id, text: `${MARK}${item.text}` })),
        selection: { provider: 'stub', model: 'stub' },
        source: 'default',
        reasoned: false,
      }),
    })
  })
  return batches
}

/** URL to load: the one `dsh web` printed, token included. */
const APP_URL = process.env.DSH_E2E_URL ?? '/'

/** Open the panel from its floating pill. */
async function openPanel(page: Page): Promise<void> {
  await page.waitForSelector('[data-dsh-translate-ui]', { timeout: 60_000 })
  await page.getByRole('button', { name: /翻译|Translate/ }).last().click()
}

test('translates the visible page and restores it', async ({ page }) => {
  const batches = await stubModel(page)
  await page.goto(APP_URL)
  await openPanel(page)

  const translatePage = page.getByRole('button', { name: /翻译此页|Translate this page/ })
  await expect(translatePage).toBeVisible()
  await translatePage.click()

  // Every distinct string is requested once and every block carrying it is painted.
  await expect.poll(async () => page.locator(`[${TRANSLATION_ATTRIBUTE}]`).count()).toBeGreaterThan(4)
  const attributes = await page.locator(`[${TRANSLATION_ATTRIBUTE}]`).evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-dsh-tr')))
  expect(attributes.every(text => text?.startsWith(MARK))).toBe(true)

  const requested = batches.flat()
  expect(requested.length).toBeGreaterThan(4)
  // Dedupe: a repeated string appears once in the requests...
  expect(new Set(requested.map(item => item.text)).size).toBe(requested.length)
  // ...and its answer paints every block that carried it.
  expect(await page.locator(`[${TRANSLATION_ATTRIBUTE}]`).count()).toBeGreaterThanOrEqual(requested.length)

  // Nothing literal and nothing of this plugin's own UI may be translated.
  const leaked = await page.evaluate(() => {
    const mine = '[data-dsh-tr]'
    return document.querySelectorAll(`pre ${mine}, code ${mine}, [data-dsh-translate-ui] ${mine}`).length
  })
  expect(leaked).toBe(0)

  // Blocks built from divs - the case a tag whitelist missed entirely.
  const divBlocks = await page.evaluate(() => [...document.querySelectorAll('[data-dsh-tr]')]
    .filter(node => node.tagName === 'DIV').length)
  expect(divBlocks).toBeGreaterThan(0)

  // The panel must never claim there was nothing to translate right after it
  // translated something; that was the second half of the reported bug.
  await expect(page.getByText(/没有需要翻译|Nothing on this page/)).toHaveCount(0)

  await page.getByRole('button', { name: /还原原文|Restore original text/ }).click()
  await expect.poll(async () => page.locator(`[${TRANSLATION_ATTRIBUTE}]`).count()).toBe(0)
})

test('top-up translates content that appears after the sweep', async ({ page }) => {
  const batches = await stubModel(page)
  await page.goto(APP_URL)
  await openPanel(page)
  await page.getByRole('button', { name: /翻译此页|Translate this page/ }).click()
  await expect.poll(async () => page.locator(`[${TRANSLATION_ATTRIBUTE}]`).count()).toBeGreaterThan(0)

  // Stand-in for a streaming answer or a route change: new blocks appear later.
  await page.evaluate(() => {
    const block = document.createElement('div')
    block.textContent = 'a block that appeared after the sweep'
    document.body.append(block)
  })
  await expect.poll(async () => page.locator('[data-dsh-tr="译:a block that appeared after the sweep"]').count())
    .toBe(1)
  expect(batches.length).toBeGreaterThan(1)
})

test('translates a div-built card exactly once per block', async ({ page }) => {
  await stubModel(page)
  await page.goto(APP_URL)
  await openPanel(page)
  await page.getByRole('button', { name: /翻译此页|Translate this page/ }).click()
  await expect.poll(async () => page.locator(`[${TRANSLATION_ATTRIBUTE}]`).count()).toBeGreaterThan(0)

  // The shape the skills page uses: a card div holding name, description, and a
  // meta row, with no p/li/heading anywhere. A tag whitelist reports "nothing to
  // translate" here; the leaf-block rule must find three blocks and no fourth.
  await page.evaluate(() => {
    const card = document.createElement('div')
    card.id = 'e2e-card'
    card.innerHTML = `
      <div id="e2e-name">architect</div>
      <div id="e2e-desc">Sketch types and module structure before code.</div>
      <div id="e2e-meta"><span>skills</span><span>/architect</span></div>`
    document.body.append(card)
  })

  await expect.poll(async () => page.locator('#e2e-card [data-dsh-tr]').count()).toBe(3)
  expect(await page.locator('#e2e-card').getAttribute('data-dsh-tr')).toBeNull()
  expect(await page.locator('#e2e-desc').getAttribute('data-dsh-tr'))
    .toBe('译:Sketch types and module structure before code.')
  expect(await page.locator('#e2e-meta').getAttribute('data-dsh-tr')).toBe('译:skills /architect')
})
