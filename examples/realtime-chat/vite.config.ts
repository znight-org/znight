import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

import options from './znight.config.js'

// znight() generates the dependency injection container at build time and configures a server
// build: src/main.ts -> dist/main.js (Node.js 24 target, source maps).
export default defineConfig({
  plugins: [znight(options)],
  ssr: {
    // In-repo only: keep the linked @znight/* workspaces external, like packages installed from npm.
    external: ['@znight/core', '@znight/http', '@znight/websocket'],
  },
})
