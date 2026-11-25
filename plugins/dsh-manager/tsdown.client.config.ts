import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { createRequire } from 'node:module'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

/**
 * Browser face of the dynamic client bundle.
 *
 * Mirrors the harness `clientBundle` preset contract: a CJS closure factory
 * registered under `window.__ModuleLoader__.load`, with the shell's platform
 * modules as the only externals — every other import (including our own
 * Remote contribution, which the generated-remote rule inlines) bundles in.
 *
 * CSS mirrors the preset's stylesheet loaders: a `.module.css` import yields
 * its hashed class map AND injects the same hashed stylesheet at factory
 * execution (one tagged <style> per file, idempotent). The virtual ids must
 * not end in `.css` — tsdown's own CSS guard would claim them otherwise.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** The package name stamped into the loader handoff and the style tags. */
const PLUGIN_ID = '@charonx/dsh-manager'

/**
 * Emit one style injector plus the hashed class map (the preset's
 * `styleInjectionModule`): the stylesheet lands in the document once, tagged
 * per stylesheet file, and the default export maps local class names to their
 * hashed form.
 */
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

/** Resolve a stylesheet import specifier against its importer to a physical path. */
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
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
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
  // The Remote contribution rides inside the bundle (the generated-remote
  // inlining rule), so the protocol package must never externalize here even
  // though it is a peer dependency of the package.
  noExternal: [/^@deepseek-ai\/dsh-typert-protocol/],
  // The preset contract defines the CJS scaffolding inside the closure: the
  // shell passes only `require`, so the factory declares its own module
  // object. (tsdown dropped the preset's `intro` option here, so the module
  // declaration rides in the banner.)
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
