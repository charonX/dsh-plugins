import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { defineConfig, type Alias } from 'vitest/config'

const TYPESCRIPT_MODULE = /^[^?]*\.[cm]?tsx?(?:\?|$)/
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m

/** Lower standard TS decorators so Vitest runs `@Remote` host services without bundler steps. */
function decoratorLowering() {
  return {
    name: 'dsh-manager-vitest-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!TYPESCRIPT_MODULE.test(id) || !DECORATOR_SYNTAX.test(code)) return
      const file = id.replace(/\?.*$/u, '')
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

// The client packages' published /client roots are CJS ModuleLoader factories
// meant for the harness shell; the jsdom bench must load TypeScript sources
// instead. The harness itself does this with tsconfig paths; out-of-tree we
// alias the shipped ./src trees directly (each npm package ships src/).
// Resolution anchors on the bench package, whose node_modules hold the whole
// client-graph copies (direct deps of the manager resolve from here too).
const ownRequire = createRequire(import.meta.url)
const benchRequire = createRequire(ownRequire.resolve('@deepseek-ai/dsh-client-test-runtime/package.json'))
function resolveThrough(specifier: string): string | undefined {
  try {
    return pathToFileURL(ownRequire.resolve(specifier)).href
  } catch {
    try {
      return pathToFileURL(benchRequire.resolve(specifier)).href
    } catch {
      return undefined
    }
  }
}

// specifier-under-test -> the shipped TS entry it must stand in for.
const FACADE: readonly (readonly [id: string, specifier: string])[] = [
  ['@deepseek-ai/dsh-api-session-controller/client', '@deepseek-ai/dsh-api-session-controller/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-chat/client', '@deepseek-ai/dsh-client-ui-chat/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-conversation/client', '@deepseek-ai/dsh-client-ui-conversation/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-renderer/client', '@deepseek-ai/dsh-client-ui-renderer/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-session/client', '@deepseek-ai/dsh-client-ui-session/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-ui-session-status/client', '@deepseek-ai/dsh-client-ui-session-status/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-locale/client', '@deepseek-ai/dsh-client-locale/src/client/index.ts'],
  ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-store/src/index.ts'],
  ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-slots/src/index.ts'],
  // The primitives alias targets a local facade, not the barrel: the barrel
  // pulls the whole markdown renderer (shiki, katex), while the bundled
  // client externals the package whole, so tests only need the icon face plus
  // SegmentedTabs — both light.
  ['@deepseek-ai/dsh-client-ui-primitives', './tests/client/ui-primitives.facade.ts'],
  ['@deepseek-ai/dsh-client-test-runtime', '@deepseek-ai/dsh-client-test-runtime/src/index.ts'],
]

const SINGLETON_REACT = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'react-dom/test-utils',
  '@testing-library/react',
  '@testing-library/dom',
  'use-sync-external-store',
  'use-sync-external-store/shim',
  'use-sync-external-store/shim/with-selector',
  'zustand',
] as const

export default defineConfig({
  plugins: [decoratorLowering()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      ...FACADE.flatMap(([id, specifier]): Alias[] => {
        const replacement = resolveThrough(specifier)
        if (replacement === undefined) return []
        return [{
          find: new RegExp(`^${id.replace(/[/.]/g, (ch) => ch === '/' ? '\\/' : '\\.')}$`),
          replacement,
        }]
      }),
      ...SINGLETON_REACT.map((id): Alias => ({
        find: new RegExp(`^${id.replace(/[/.]/g, (ch) => ch === '/' ? '\\/' : '\\.')}$`),
        replacement: ownRequire.resolve(id),
      })),
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Boot tests bind the web profile's fixed port; suites must not overlap.
    fileParallelism: false,
    server: {
      deps: {
        // dsh packages ship TS sources (their /client exports point at src/),
        // so the client test bench must transform them instead of Node.
        // Inline react / react-dom / testing-library too so symlinked harness
        // packages resolve the single aliased React instance instead of Node CJS copies.
        inline: [/@deepseek-ai\//, /[/\\]deepseek-harness[/\\]/, /(?:^|[/\\])react(?:-dom)?(?:[/\\]|$)/, /@testing-library/, /use-sync-external-store/, /zustand/],
      },
    },
  },
})
