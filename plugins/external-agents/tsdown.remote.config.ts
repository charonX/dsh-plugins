import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/remote.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  dts: true,
  clean: false,
  external: ['@deepseek-ai/dsh-typert-protocol', 'zod'],
})
