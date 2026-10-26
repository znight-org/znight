import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    compiler: 'src/compiler/index.ts',
  },
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
})
