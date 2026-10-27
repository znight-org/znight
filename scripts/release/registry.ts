/**
 * Read-only npm registry queries (no authentication: the packages are public).
 */

/** Registry URL, `ZNIGHT_NPM_REGISTRY` to test against another registry (e.g. Verdaccio). */
export const REGISTRY: string = (process.env['ZNIGHT_NPM_REGISTRY'] ?? 'https://registry.npmjs.org').replace(/\/+$/, '')

const ATTEMPTS = 3

/** The versions of a package published on the registry (empty when the package does not exist). */
export async function publishedVersions(name: string): Promise<ReadonlySet<string>> {
  const url = `${REGISTRY}/${name.replace('/', '%2F')}`
  let lastError: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 404) return new Set()
      if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`)
      const body = (await response.json()) as { versions?: Record<string, unknown> }
      return new Set(Object.keys(body.versions ?? {}))
    } catch (error) {
      lastError = error
      await Bun.sleep(1000 * attempt)
    }
  }
  throw new Error(`Cannot query the npm registry for ${name}: ${String(lastError)}`)
}

/** The highest published version, or undefined. */
export function highestVersion(versions: Iterable<string>): string | undefined {
  let highest: string | undefined
  for (const version of versions) {
    if (highest === undefined || Bun.semver.order(version, highest) > 0) highest = version
  }
  return highest
}
