import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/** Package name doubles as the client module id in the loader handoff. */
const { name } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }

/**
 * Browser half of the bundle: one CommonJS factory handed to the host module
 * loader. Only the loader's platform modules stay external, so `react` and its
 * JSX runtime resolve through the host table instead of being duplicated.
 */
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'client',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: false,
  clean: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
