import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { createRequire } from 'node:module'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const PLUGIN_ID = '@charonx/dsh-external-agents'

function styleInjectionModule(fileId: string, css: string, classMap: Readonly<Record<string, string>>): string {
  const tagId = `${PLUGIN_ID}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\') {',
    '  const selector = \'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\';',
    '  let tag = document.querySelector(selector);',
    '  if (tag === null) {',
    '    tag = document.createElement(\'style\');',
    `    tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
    '    tag.dataset.pluginCss = tagId;',
    '    document.head.appendChild(tag);',
    '  }',
    '  if (tag.textContent !== css) tag.textContent = css;',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

function stylesheetPath(source: string, importer: string | undefined): string {
  if (importer === undefined) return source
  if (!source.startsWith('.') && !isAbsolute(source)) return createRequire(importer).resolve(source)
  return resolvePath(dirname(importer), source)
}

const cssModulesPlugin = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = stylesheetPath(source, importer)
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  load(virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    const source = readFileSync(fileId, 'utf8')
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: Buffer.from(source),
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
    return styleInjectionModule(fileId, code.toString(), classMap)
  },
}

const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

export default defineConfig({
  entry: ['src/client/index.ts'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  external: (id: string) => PLATFORM_MODULES.includes(id),
  noExternal: [/^@deepseek-ai\/dsh-typert-protocol/],
  banner: [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
  ].join('\n'),
  footer: 'return module.exports; } });',
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
  },
  outExtensions: () => ({ js: '.js' }),
  plugins: [cssModulesPlugin],
})
