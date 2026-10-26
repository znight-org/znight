import type { ZnightOptions } from '@znight/compiler'

/**
 * Options of the Znight compiler, shared by the Vite plugin (`vite.config.ts`: dev, build) and the
 * Bun preload (`bunfig.toml`: tests).
 */
export default {
  // a @Body / @Message without schema is a build error, not a warning (ZNIGHT017)
  strictValidation: true,
  // warn about providers nothing uses (ZNIGHT019)
  reportUnused: true,
} satisfies ZnightOptions
