/**
 * Every example that ships `.env*` files turns Bun's automatic `.env` loading off (`env = false` in
 * its `bunfig.toml`). Otherwise `bun dist/main.js` without `NODE_ENV` runs in Bun's `development`
 * mode and loads `.env.development` into `process.env` before ConfigPlugin runs, so the committed
 * development keys and flags would apply in production.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, test as it } from 'bun:test'

const REPO = resolve(import.meta.dir, '..')
const EXAMPLES = join(REPO, 'examples')

/** Directories holding a `package.json` under `examples/` (the monorepo services included). */
function exampleApps(directory: string): string[] {
  const apps: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (existsSync(join(path, 'package.json'))) apps.push(path)
    apps.push(...exampleApps(path))
  }
  return apps
}

/** Whether `bunfig.toml` sets `env = false` in its root table (the rule Bun applies). */
function disablesBunEnv(app: string): boolean {
  const file = join(app, 'bunfig.toml')
  if (!existsSync(file)) return false
  const root = readFileSync(file, 'utf8').split(/^\s*\[/m)[0] ?? ''
  return /^\s*env\s*=\s*false\s*(?:#.*)?$/m.test(root)
}

describe('examples and .env files', () => {
  const withEnvFiles = exampleApps(EXAMPLES).filter(app =>
    readdirSync(app).some(name => name === '.env' || name.startsWith('.env.')),
  )

  it('finds the examples that ship .env files', () => {
    expect(withEnvFiles.length).toBeGreaterThan(0)
  })

  for (const app of withEnvFiles) {
    it(`${relative(REPO, app)} disables Bun's automatic .env loading`, () => {
      expect(disablesBunEnv(app)).toBe(true)
    })
  }
})
