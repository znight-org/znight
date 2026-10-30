import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

export default defineConfig({
  // The default server build: src/main.ts -> dist/main.js, Znight decorators stripped
  plugins: [znight()],
  ssr: {
    // In-repo only: the @znight/* packages are linked workspaces; keep them external, like packages
    // installed from npm are.
    external: ['@znight/core', '@znight/http'],
  },
})
