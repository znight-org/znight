import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

import options from './znight.config.ts'

// znight() generates the dependency injection container at build time and configures a server
// build: src/main.ts -> dist/main.js (Node.js 24 target, source maps).
//
// Workspace packages are bundled by Vite: @znight-examples/shared (TypeScript sources, decorators
// stripped by znight()) ends up in dist/main.js. Packages installed from npm stay external.
export default defineConfig({
  plugins: [znight(options)],
  ssr: {
    // In this repository only: the @znight/* packages are workspaces too (in your project they come
    // from npm and are external by default). Keep them external like any installed dependency.
    external: ['@znight/config', '@znight/core', '@znight/messaging', '@znight/observability'],
  },
})
