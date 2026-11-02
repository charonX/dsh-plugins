/**
 * Load the built browser bundle outside a browser and assert the registration
 * shape the host module loader expects. Run `npm run build` first.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
let registration
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
const factory = new Function('require', readFileSync(join(root, 'client', 'client.js'), 'utf8'))
factory((specifier) => require(specifier))
if (registration === undefined) throw new Error('client bundle did not register with __ModuleLoader__')

const registered = { locale: null, slots: [] }
const ctx = {
  effect: (create) => create(),
  locale: {
    register: (namespace, dictionaries) => { registered.locale = { namespace, dictionaries }; return () => {} },
    bind: (namespace) => (key) => `${namespace}:${key}`,
  },
  slots: {
    inject: (_key, create) => { create(); return () => {} },
    register: (options, component) => { registered.slots.push({ options, component }); return () => {} },
  },
}
registration.factory((specifier) => require(specifier)).apply(ctx)
const panel = registered.slots.find((entry) => entry.options.name === 'main')
if (panel === undefined) throw new Error('client bundle did not register the main slot')
const sidebar = registered.slots.find((entry) => entry.options.name === 'sidebar.panellist')
if (sidebar === undefined) throw new Error('client bundle did not register the sidebar.panellist slot')
console.log(JSON.stringify({
  id: registration.id,
  locale: registered.locale?.namespace,
  locales: Object.keys(registered.locale?.dictionaries ?? {}),
  panel: { key: panel.options.key },
  sidebar: { id: sidebar.options.id, order: sidebar.options.order },
  components: [panel.component.name, sidebar.component.name],
}))
