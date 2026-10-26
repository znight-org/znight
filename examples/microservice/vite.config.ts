import { fileURLToPath } from 'node:url'
import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

import options from './znight.config.ts'

/** A file of a package installed for @znight/observability (in-repo development only, see below). */
const fromObservability = (file: string): string =>
  fileURLToPath(new URL(`../../packages/observability/node_modules/${file}`, import.meta.url))

// znight() generates the dependency injection container at build time and configures a server
// build: src/main.ts -> dist/main.js (Node.js 24 target, source maps), also run by Bun.
export default defineConfig({
  plugins: [znight(options)],

  // ---- In-repo development only: not needed in your project -------------------------------------
  ssr: {
    // The @znight/* packages are workspace links here, which Vite bundles by default: keep them
    // external, like packages installed from npm (they resolve their own dependencies at runtime).
    external: ['@znight/config', '@znight/core', '@znight/http', '@znight/messaging', '@znight/observability'],
    // The OpenTelemetry SDK is not a dependency of this workspace yet (see tsconfig.json): bundle it
    // from the copies installed for @znight/observability.
    noExternal: [/^@opentelemetry\//],
  },
  resolve: {
    alias: {
      '@opentelemetry/api': fromObservability('@opentelemetry/api/dist/index.mjs'),
      '@opentelemetry/sdk-trace-base': fromObservability('@opentelemetry/sdk-trace-base/build/esm/index-shim.js'),
      '@opentelemetry/context-async-hooks': fromObservability('@opentelemetry/context-async-hooks/dist/index.mjs'),
    },
  },
})
