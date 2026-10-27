/**
 * Packs every publishable package with `bun pm pack` and verifies the tarballs, without publishing.
 * Run after `bun run build`.
 *
 *   bun scripts/release/pack.ts                 # pack into a temporary directory, then delete it
 *   bun scripts/release/pack.ts --out dist-pack # keep the tarballs
 *   bun scripts/release/pack.ts --strict        # a missing README is an error (as when releasing)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { log, main } from './support.ts'
import { packAndVerify, reportPacked } from './tarball.ts'
import { publishablePackages } from './workspace.ts'

main(async () => {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      strict: { type: 'boolean', default: false },
    },
  })
  const outDir = values.out === undefined ? mkdtempSync(join(tmpdir(), 'znight-pack-')) : resolve(values.out)
  try {
    const packages = publishablePackages()
    log.step(`Packing ${packages.length} packages into ${outDir}`)
    const packed = await packAndVerify(packages, outDir, { missingReadme: values.strict ? 'error' : 'warning' })
    const errors = reportPacked(packed)
    if (errors > 0) throw new Error(`${errors} problem(s) found in the tarballs`)
    log.info('\nAll tarballs are valid.')
  } finally {
    if (values.out === undefined) rmSync(outDir, { recursive: true, force: true })
  }
})
