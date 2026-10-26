/**
 * `@znight/compiler/bun`: the Bun preload (§6.3). Importing this module **runs** it:
 *
 * ```toml
 * # bunfig.toml
 * [test]
 * preload = ["@znight/compiler/bun"]
 * ```
 *
 * or `bun --preload @znight/compiler/bun src/main.ts` (also with `--watch` / `--hot`). It reads the
 * options of `znight.config.ts` (see `loadZnightConfig`), regenerates the container, prints the
 * diagnostics, fails on errors and registers the Bun plugin serving the generated module.
 *
 * Custom preload files use the side-effect-free API of the package root instead:
 * `import { createPreload } from '@znight/compiler'`.
 */
import { createPreload, loadZnightConfig } from './bun-plugin.ts'

const { options } = await loadZnightConfig()
await createPreload(options)
