import ts from 'typescript'
import { defineConfig } from 'tsdown'

/**
 * Lower standard TypeScript decorators before bundling — the same transform
 * the harness's typert generator applies — because no Node runtime parses
 * decorator syntax natively yet. Idempotent, source-map preserving.
 */
function decoratorLowering(): {
  name: string
  transform: { filter: { id: RegExp }; handler: (code: string, id: string) => { code: string; map: string } | undefined }
} {
  const TYPESCRIPT_MODULE = /^[^?]*\.[cm]?tsx?(?:\?|$)/
  const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m
  return {
    name: 'dsh-manager-decorators',
    transform: {
      filter: { id: TYPESCRIPT_MODULE },
      handler(code, id) {
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
          map: result.sourceMapText as string,
        }
      },
    },
  }
}

/** Node-host face: the Cordis plugin service. */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  plugins: [decoratorLowering()],
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-brand',
    '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/schemastery',
    'zod',
  ],
})
