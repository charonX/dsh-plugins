import { resolve } from 'node:path'
import { setupDshWebGlobal } from '../../../scripts/e2e-web-harness.mjs'

export default async function globalSetup() {
  return setupDshWebGlobal({
    dshRoot: resolve(import.meta.dirname, '../../..'),
    requiredBundles: ['@charonx/dsh-manager'],
  })
}
