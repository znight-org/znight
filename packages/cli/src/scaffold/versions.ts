/**
 * Version ranges of the third-party dependencies of new projects. `@znight/*` packages use
 * `^<version of @znight/cli>` (they are released in lockstep).
 */
export const DEPENDENCY_VERSIONS: Readonly<Record<string, string>> = {
  '@hono/node-server': '^2.1.5',
  '@types/bun': '^1.3.0',
  '@types/express': '^5.0.6',
  '@types/node': '^24.0.0',
  express: '^5.3.0',
  fastify: '^5.12.7',
  hono: '^4.13.14',
  'light-my-request': '^6.8.0',
  typescript: '^7.0.0',
  vite: '^8.0.0',
  vitest: '^4.1.0',
  zod: '^4.6.0',
}

/** Range of a third-party dependency. */
export function versionOf(name: string): string {
  const version = DEPENDENCY_VERSIONS[name]
  if (version === undefined) throw new Error(`[znight] no version declared for ${name}`)
  return version
}
