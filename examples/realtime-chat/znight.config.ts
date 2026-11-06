import type { ZnightOptions } from '@znight/compiler'

/** Options of the Znight compiler, shared by the Vite plugin and the Bun preload. */
export default {
  // A payload or a body without schema is a build error (ZNIGHT017), not a warning.
  strictValidation: true,
} satisfies ZnightOptions
