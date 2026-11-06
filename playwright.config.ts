import { defineConfig } from '@playwright/test'

/**
 * End-to-end configuration for the browser half.
 *
 * The suite drives a real `dsh web` (start it with `../dev.sh` or
 * `pnpm dsh web --port 3080`) and stubs only the translate route, so the DOM
 * scanning, batching, painting, and restore paths run against the real page.
 * The model is never called: no API key, no quota, no flaky latency.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    // `DSH_E2E_URL` is the URL `dsh web` prints, token included; without it the
    // loopback server answers 401 before any test runs.
    baseURL: process.env.DSH_E2E_URL ?? 'http://127.0.0.1:3080',
    // The installed Chrome is used on purpose: no browser download in CI-free
    // local runs, and the same engine the Desktop app ships.
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
})
