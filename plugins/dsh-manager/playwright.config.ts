import { defineConfig } from '@playwright/test'

/**
 * Browser E2E configuration for `@charonx/dsh-manager`.
 *
 * Boots an isolated `dsh web` instance (see `e2e/global-setup.mjs`) against
 * a temporary `DSH_HOME` by default so real host/remote/client flows run
 * without touching `~/.dsh`. Set `DSH_E2E_URL` to target a running server.
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.mjs',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.DSH_E2E_URL ?? 'http://127.0.0.1:3080',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
})
