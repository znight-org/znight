#!/usr/bin/env node
// Launcher of the `znight` binary. It is committed (unlike dist/) so that package managers link the
// binary at install time, even in this repository before the packages are built.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cli = new URL('../dist/cli.mjs', import.meta.url)

if (!existsSync(fileURLToPath(cli))) {
  console.error(
    '@znight/cli is not built: dist/cli.mjs is missing.\n' +
      'In the Znight repository, build the packages first: bun install && bun run build',
  )
  process.exit(1)
}

await import(cli.href)
