import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

import options from './znight.config.js'

// znight() generates the dependency injection container at build time and configures a server
// build: src/main.ts -> dist/main.js (Node.js 24 target, source maps).
export default defineConfig({
  plugins: [znight(options)],
  ssr: {
    // In-repo only: the @znight/* packages are linked workspaces here, and Vite bundles linked
    // packages (their own dependencies, such as pino, would then be unresolvable from dist/). Keep
    // them external, like packages installed from npm are. Not needed in your project.
    external: ['@znight/config', '@znight/core', '@znight/http', '@znight/observability'],
  },
})
