import { znight } from '@znight/compiler'
import { openapi } from '@znight/openapi/vite'
import { defineConfig } from 'vite'

import options from './znight.config.js'

export default defineConfig({
  plugins: [
    // Generates the dependency injection container (and the OpenAPI operation model) at build time,
    // and configures a server build: src/main.ts -> dist/main.js (Node.js 24 target, source maps).
    znight(options),
    // After the bundle is written, emits the OpenAPI document: `dist/openapi.json` (served in
    // production, see src/main.ts) and `openapi.json` (committed, the source of the typed client).
    // In CI the committed file is left alone: `bun run openapi:check` fails when it is stale. (The
    // `check` option would not do here: it never writes, `dist/openapi.json` included.)
    // `converters` must be the module the application passes to OpenApiPlugin (src/http.ts).
    openapi({
      output: process.env.CI === 'true' ? 'dist/openapi.json' : ['openapi.json', 'dist/openapi.json'],
      converters: 'src/openapi.converters.ts',
    }),
  ],
  ssr: {
    // In-repo only: the @znight/* packages are linked workspaces here, and Vite bundles linked
    // packages (their own dependencies would then be unresolvable from dist/). Keep them external,
    // like packages installed from npm are. Not needed in your project.
    external: ['@znight/config', '@znight/core', '@znight/http', '@znight/observability', '@znight/openapi'],
  },
})
