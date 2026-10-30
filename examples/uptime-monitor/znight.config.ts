import type { ZnightOptions } from '@znight/compiler'

/**
 * Options of the Znight compiler, shared by the Vite plugin (`vite.config.ts`: `znight build`,
 * `znight dev`, `znight generate`) and the Bun preload (`bun test`), so that every tool generates the
 * same container.
 */
export default {
  // A request body or query without schema is a build error (ZNIGHT017), not a warning.
  strictValidation: true,
  // Warn about providers that nothing uses (ZNIGHT019). Job hosts count as used: the schedule
  // extension declares them as entry points.
  reportUnused: true,
} satisfies ZnightOptions
