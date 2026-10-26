import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

import options from './znight.config.ts'

// znight() generates the dependency injection container at build time and configures a server
// build: src/main.ts -> dist/main.js (Node.js 24 target, source maps). There is no HTTP server in
// this application: the same build runs a background worker.
export default defineConfig({
  plugins: [znight(options)],
})
