import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const TYPESCRIPT_MODULE = /^[^?]*\.[cm]?tsx?(?:\?|$)/
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m

export default defineConfig({
  plugins: [
    {
      name: 'external-agents-vitest-decorators',
      enforce: 'pre',
      transform(code, id) {
        if (!TYPESCRIPT_MODULE.test(id) || !DECORATOR_SYNTAX.test(code)) return undefined
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
    },
  ],
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
