import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    compiler: 'src/compiler/index.ts',
    testing: 'src/testing.ts',
    yoga: 'src/yoga.ts',
  },
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
})
