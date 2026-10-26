/**
 * The generated module type-checks with TypeScript 7 under max-strict user settings (`strict`,
 * `noUnusedLocals`, `noUnusedParameters`, `noPropertyAccessFromIndexSignature`,
 * `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`,
 * `experimentalDecorators`): see `test/fixtures/codegen/*\/tsconfig.json`.
 */
import { fixtureRoot, generateFixture, typecheck } from './helpers.ts'
import { webExtension } from './web-extension.ts'
import { describe, expect, test as it } from 'bun:test'

describe('typecheck of the generated module (tsc 7, max-strict)', () => {
  for (const [name, options] of [
    ['app', {}],
    ['naming', {}],
    ['web', { extensions: [webExtension] }],
  ] as const) {
    it(`type-checks the '${name}' fixture and its generated module`, async () => {
      await generateFixture(name, options)
      const result = typecheck(fixtureRoot(name))
      if (result.errors.length > 0) {
        console.error(result.output)
      }
      expect(result.errors).toEqual([])
    }, 30_000)
  }

  it('reports type errors of the generated code (sanity check of the harness)', async () => {
    const result = await generateFixture('app', { mode: 'build' })
    const original = await Bun.file(result.outFile).text()
    try {
      await Bun.write(result.outFile, original.replace("scope: 'singleton'", "scope: 'forever'"))
      expect(typecheck(fixtureRoot('app')).errors.length).toBeGreaterThan(0)
    } finally {
      await Bun.write(result.outFile, original)
    }
  }, 30_000)
})
