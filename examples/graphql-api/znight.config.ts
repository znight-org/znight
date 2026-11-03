import type { ZnightOptions } from '@znight/compiler'

import graphql from '@znight/graphql/compiler'

/**
 * Options of the Znight compiler, shared by the Vite plugin (`vite.config.ts`: `znight build`,
 * `znight dev`, `znight generate`) and the Bun preload (`bun test`), so that every tool generates the
 * same container and the same schema.
 */
export default {
  // The configured copy replaces the discovered extension: it also writes the schema derived from
  // the types to schema.graphql (committed: every pull request shows its schema diff), and
  // `znight generate --check` fails when the committed file is stale.
  extensions: [graphql.configure({ sdl: 'schema.graphql' })],
  // Warn about providers that nothing uses (ZNIGHT019). Resolvers count as used: the GraphQL
  // extension declares them as entry points.
  reportUnused: true,
} satisfies ZnightOptions
