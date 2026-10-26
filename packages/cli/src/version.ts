import { readFileSync } from 'node:fs'

let cached: string | undefined

/**
 * Version of `@znight/cli`, read from its `package.json` (one level above both `src/` and `dist/`).
 * Projects created by `znight new` depend on `@znight/*` packages at `^<version>`.
 */
export function cliVersion(): string {
  if (cached === undefined) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      const version = (manifest as { version?: unknown }).version
      cached = typeof version === 'string' ? version : '0.0.0'
    } catch {
      cached = '0.0.0'
    }
  }
  return cached
}
