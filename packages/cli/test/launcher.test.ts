import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

const LAUNCHER = join(import.meta.dir, '../bin/znight.mjs')

function packageWith(dist: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'znight-launcher-'))
  mkdirSync(join(root, 'bin'))
  copyFileSync(LAUNCHER, join(root, 'bin/znight.mjs'))
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }')
  if (dist !== undefined) {
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist/cli.mjs'), dist)
  }
  return root
}

describe('bin/znight.mjs', () => {
  it('explains how to build the CLI when dist/ is missing', () => {
    const root = packageWith(undefined)
    try {
      const result = spawnSync(process.execPath, [join(root, 'bin/znight.mjs')], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('dist/cli.mjs is missing')
      expect(result.stderr).toContain('bun run build')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs the built CLI', () => {
    const root = packageWith("console.log('built cli ran')\n")
    try {
      const result = spawnSync(process.execPath, [join(root, 'bin/znight.mjs')], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('built cli ran')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
