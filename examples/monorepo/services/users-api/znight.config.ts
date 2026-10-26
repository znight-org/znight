import type { ZnightOptions } from '@znight/compiler'

/**
 * Compiler options, shared by the Vite plugin (vite.config.ts: `znight build`, `znight dev`,
 * `znight generate`) and the Bun preload (bunfig.toml: `bun test`).
 *
 * `@znight-examples/shared` needs no option: its package.json opts in as a source provider library
 * (`"znight": { "library": "source" }`), so the compiler scans it because it is a dependency.
 */
export default {
  // every request body must be validated by a schema (ZNIGHT017 becomes an error)
  strictValidation: true,
  // drop the providers that nothing uses from the generated container, hence from the bundle: here
  // the library's RandomIdGenerator, superseded by the @Primary SortableIdGenerator
  // (`reportUnused: true` also reports them, as ZNIGHT019 warnings)
  prune: true,
} satisfies ZnightOptions
