import { defineConfig } from 'tsdown'

export default defineConfig({
  // the orphan guard is preloaded into the application by `znight dev`: a module of its own
  entry: ['src/index.ts', 'src/cli.ts', 'src/dev/orphan-guard.ts'],
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
})
