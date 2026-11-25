import { defineConfig } from 'tsdown'

/** Remote contribution face: hand-written generated-shape artifact. */
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
