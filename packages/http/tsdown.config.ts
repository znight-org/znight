import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    path: 'src/path.ts',
    node: 'src/adapters/node.ts',
    fastify: 'src/adapters/fastify.ts',
    express: 'src/adapters/express.ts',
    hono: 'src/adapters/hono.ts',
    compiler: 'src/compiler/index.ts',
  },
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
})
