/**
 * Input files (`ValidateContext.inputFiles`, §6.5): non-source files an extension reads (a
 * `.graphql` schema) are matched by globs relative to the root, read as UTF-8, sorted, part of
 * `watchFiles`, and creating a file matching the patterns of the last compile is a relevant change.
 */
import type { CompilerExtension, InputFile } from '../src/index.ts'

import fs from 'node:fs'

import { createCompiler } from '../src/compiler.ts'
import { isRelevantChange } from '../src/watch.ts'
import { tempApp } from './analysis/helpers.ts'
import { render } from './codegen/helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

/** An extension reading `patterns` in `validate`, exposing what it read. */
function reader(patterns: readonly string[]): { extension: CompilerExtension; read: () => readonly InputFile[] } {
  let files: readonly InputFile[] = []
  return {
    extension: {
      apiVersion: 1,
      name: 'reader',
      decorators: {},
      validate(ctx) {
        files = ctx.inputFiles(patterns)
      },
    },
    read: () => files,
  }
}

describe('ValidateContext.inputFiles()', () => {
  const app = tempApp({
    'src/service.ts': 'export const service = 1\n',
    'src/users/user.graphql': 'type User { id: ID! }\n',
    'src/a.graphql': 'type Query { a: String }\n',
    'src/legacy/old.graphql': 'type Old { id: ID! }\n',
    'src/.hidden/x.graphql': 'type Hidden { id: ID! }\n',
    'node_modules/pkg/schema.graphql': 'type Package { id: ID! }\n',
  })
  afterAll(() => app.cleanup())

  it('reads the matching files, sorted, without node_modules nor dot-directories', async () => {
    const { extension, read } = reader(['src/**/*.graphql', '!src/legacy/**'])
    const compiler = createCompiler({ root: app.root, extensions: [extension] })
    const result = await compiler.compile()
    expect(render(app.root, result.diagnostics)).toBe('')
    expect(read()).toEqual([
      { file: `${app.root}/src/a.graphql`, relativeFile: 'src/a.graphql', text: 'type Query { a: String }\n' },
      {
        file: `${app.root}/src/users/user.graphql`,
        relativeFile: 'src/users/user.graphql',
        text: 'type User { id: ID! }\n',
      },
    ])
    expect(result.watchFiles).toContain(`${app.root}/src/a.graphql`)
    expect(result.watchFiles).toContain(`${app.root}/src/users/user.graphql`)
    expect(result.watchFiles).not.toContain(`${app.root}/src/legacy/old.graphql`)
  })

  it('makes the creation of a matching file a relevant change, not of another file', async () => {
    const { extension } = reader(['src/**/*.graphql'])
    const compiler = createCompiler({ root: app.root, extensions: [extension] })
    const result = await compiler.compile()
    const watched = new Set(result.watchFiles)
    const created = `${app.root}/src/events/event.graphql`
    const other = `${app.root}/src/events/notes.txt`
    app.write('src/events/event.graphql', 'type Event { id: ID! }\n')
    app.write('src/events/notes.txt', 'notes\n')
    expect(isRelevantChange(compiler, 'added', created, watched, [])).toBe(true)
    expect(isRelevantChange(compiler, 'added', other, watched, [])).toBe(false)
    // a removed input file is a known file
    expect(isRelevantChange(compiler, 'removed', `${app.root}/src/a.graphql`, watched, [])).toBe(true)
    // without patterns, nothing changes
    const plain = createCompiler({ root: app.root })
    await plain.compile()
    expect(isRelevantChange(plain, 'added', created, new Set(), [])).toBe(false)
    fs.rmSync(`${app.root}/src/events`, { recursive: true })
  })

  it('rejects invalid patterns', async () => {
    const compiler = createCompiler({ root: app.root })
    await compiler.compile()
    expect(() => compiler.project.inputFiles([''])).toThrow('expects an array of non-empty glob strings')
    expect(() => compiler.project.inputFiles('src/*.graphql' as never)).toThrow('expects an array')
  })
})
