/**
 * Emission of the document (opt-in, `ZNIGHT_E2E=1`, `bun run test:e2e`): `znight openapi` compiles
 * the application, loads its generated module in a child process (Node.js: a Vite server; Bun: the
 * compiler preload) and assembles the document. Whatever the runtime, the file must be byte for byte
 * the committed `openapi.json`, since clients are generated from it, and the committed client types
 * must be what openapi-typescript generates from it (`client:check`).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { committedOpenApi, validateOpenApi } from './support/openapi.js'
import { run, znightCli } from './support/process.js'
import { afterAll, describe, expect, test as it } from 'bun:test'

const ENABLED = process.env.ZNIGHT_E2E === '1'
const TIMEOUT = 60_000

/** What `bun run openapi` passes: the converters of src/http.ts (see src/openapi.converters.ts). */
const CONVERTERS = ['--converters', 'src/openapi.converters.ts']

describe.skipIf(!ENABLED)('znight openapi', () => {
  const out = mkdtempSync(join(tmpdir(), 'storefront-openapi-'))

  afterAll(() => {
    rmSync(out, { recursive: true, force: true })
  })

  for (const runtime of ['node', 'bun'] as const) {
    it(
      `--check passes with --runtime ${runtime}: openapi.json is up to date`,
      async () => {
        const check = await run('node', [znightCli(), 'openapi', '--check', '--runtime', runtime, ...CONVERTERS])

        expect(check.output).toContain(`openapi.json up to date (13 operations, ${runtime}`)
        expect(check.code).toBe(0)
      },
      TIMEOUT,
    )

    it(
      `writes the committed document with --runtime ${runtime}`,
      async () => {
        const file = join(out, `${runtime}.json`)

        const emit = await run('node', [znightCli(), 'openapi', '-o', file, '--runtime', runtime, ...CONVERTERS])

        expect(emit.code).toBe(0)
        const emitted = readFileSync(file, 'utf8')
        expect(emitted).toBe(committedOpenApi())
        expect(await validateOpenApi(JSON.parse(emitted))).toMatchObject({ valid: true, version: '3.1' })
      },
      TIMEOUT,
    )
  }

  it(
    'client:check passes: src/client/schema.d.ts is the openapi-typescript output of openapi.json',
    async () => {
      // npm exec gives openapi-typescript its own TypeScript 5 (this repository uses TypeScript 7)
      const check = await run('npm', ['run', 'client:check'])

      if (check.code !== 0) throw new Error(`client:check failed:\n${check.output}`)
    },
    TIMEOUT,
  )

  it(
    'fails the check of a stale document',
    async () => {
      // the committed document, with an operation the code does not have
      const stale = join(out, 'stale.json')
      const document = JSON.parse(committedOpenApi())
      document.paths['/products'].delete = { responses: { 204: { description: 'Gone' } } }
      await Bun.write(stale, `${JSON.stringify(document, null, 2)}\n`)

      const check = await run('node', [znightCli(), 'openapi', '--check', '-o', stale, ...CONVERTERS])

      expect(check.code).toBe(1)
      expect(check.output).toContain('is out of date')
    },
    TIMEOUT,
  )
})
