import type { CompileResult, Diagnostic } from '@znight/compiler'

import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, formatDiagnostics } from '@znight/compiler'

import options from '../znight.config.js'
import { afterAll, describe, expect, test as it } from 'bun:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const copies: string[] = []

afterAll(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true })
})

/**
 * Compiles a copy of this application after `edits` (file → find → replace): what `znight build`
 * (or `bun test`) would say about the change. `compile()` writes nothing. Keeps the "Try breaking it"
 * section of the README honest.
 */
async function compileWith(edits: readonly (readonly [file: string, find: string, replace: string])[]): Promise<{
  readonly result: CompileResult
  readonly root: string
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graphql-api-build-')))
  copies.push(root)
  cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true, filter: source => !source.includes('.znight') })
  for (const file of ['package.json', 'tsconfig.json']) cpSync(join(ROOT, file), join(root, file))
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
  for (const [file, find, replace] of edits) {
    const path = join(root, file)
    const source = readFileSync(path, 'utf8')
    if (!source.includes(find)) throw new Error(`${file} does not contain ${find}`)
    writeFileSync(path, source.replace(find, replace))
  }
  // in-repo: the @znight/* packages are analysed from their TypeScript sources
  const result = await compile({ ...options, root, conditions: ['@znight/source'] })
  return { result, root }
}

const errors = (result: CompileResult): Diagnostic[] => result.diagnostics.filter(d => d.severity === 'error')

/** 1-based line and column of `needle` on the first line of `file` that contains it. */
function positionOf(root: string, file: string, needle: string): { line: number; column: number } {
  const lines = readFileSync(join(root, file), 'utf8').split('\n')
  const index = lines.findIndex(text => text.includes(needle))
  return { line: index + 1, column: (lines[index]?.indexOf(needle) ?? 0) + 1 }
}

describe('build-time checks of the schema', () => {
  it('the application compiles as is', async () => {
    const { result } = await compileWith([])

    expect(errors(result)).toEqual([])
  }, 30_000)

  it('ZNIGHT060: a property GraphQL cannot express, at the property, with the path from a root field', async () => {
    const { result, root } = await compileWith([
      [
        'src/catalog/book.ts',
        '  readonly tags: readonly string[]\n',
        '  readonly tags: readonly string[]\n  readonly cover: Uint8Array | null\n',
      ],
    ])

    const [error, ...others] = errors(result)
    expect(others).toEqual([])
    expect(error?.code).toBe('ZNIGHT060')
    expect(error?.message).toContain('Book.cover')
    expect(error?.location?.file).toEndWith('/src/catalog/book.ts')
    expect(error?.location).toMatchObject(positionOf(root, 'src/catalog/book.ts', 'Uint8Array | null'))
    const report = formatDiagnostics([error as Diagnostic], { color: false, cwd: root })
    expect(report).toContain('--> src/catalog/book.ts')
    expect(report).toContain('reached from Query.books → BookPage.items → Book')
  }, 30_000)

  it('ZNIGHT064: union members that cannot be told apart at runtime', async () => {
    // without `kind` on Author, no property has a different literal value in every member
    const { result, root } = await compileWith([['src/catalog/book.ts', "  readonly kind: 'author'\n", '']])

    const [error, ...others] = errors(result)
    expect(others).toEqual([])
    expect(error?.code).toBe('ZNIGHT064')
    expect(error?.message).toContain('SearchResult')
    expect(error?.location?.file).toEndWith('/src/search/search.ts')
    expect(error?.location).toMatchObject(positionOf(root, 'src/search/search.ts', 'SearchResult'))
  }, 30_000)

  it('ZNIGHT023: a root field without access decision', async () => {
    const { result } = await compileWith([['src/search/search.resolver.ts', '  @Public()\n', '']])

    expect(errors(result).map(error => error.code)).toEqual(['ZNIGHT023'])
    expect(errors(result)[0]?.message).toContain('Query.search')
  }, 30_000)
})
