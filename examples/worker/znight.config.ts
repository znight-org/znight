import type { ZnightOptions } from '@znight/compiler'

/**
 * Compiler options, shared by the Vite plugin (`vite.config.ts`: `znight build`, `znight dev`) and the
 * Bun preload (`bunfig.toml`: `bun test`), so that every tool generates the same container.
 */
export default {
  // a @Message() parameter without schema is a build error (ZNIGHT017) instead of a warning:
  // every payload entering the worker is validated
  strictValidation: true,
  // warn about providers nothing uses (ZNIGHT019)
  reportUnused: true,
} satisfies ZnightOptions
