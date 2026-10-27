import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    compiler: 'src/compiler/index.ts',
    emit: 'src/emit/index.ts',
    'emit-child': 'src/emit/child.ts',
    vite: 'src/vite.ts',
    testing: 'src/testing.ts',
  },
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    '@znight/compiler',
    '@znight/http',
    'vite',
    'yaml',
    '@valibot/to-json-schema',
    '@cfworker/json-schema',
    '@scalar/api-reference',
    'swagger-ui-dist',
  ],
})
