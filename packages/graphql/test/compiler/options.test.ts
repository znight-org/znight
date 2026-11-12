/**
 * Options of the extension (RFC 0005 §6.7): the default export, `configure()`, the SDL artifact.
 */
import graphql, { graphqlCompilerExtension } from '../../src/compiler/index.ts'
import { CATALOG } from './fixtures.ts'
import { cleanupApps, compileApp, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

describe('graphql.configure()', () => {
  it('the default export is the extension with its default options', () => {
    expect(graphql).toBe(graphqlCompilerExtension)
    expect(graphql).toMatchObject({
      apiVersion: 1,
      name: 'graphql',
      options: { sdl: false, number: 'Float', schema: false, ignoredDirectives: [] },
    })
    expect(Object.isFrozen(graphql)).toBe(true)
  })

  it('returns configured copies, options merged onto the current ones', () => {
    const sdl = graphql.configure({ sdl: 'schema.graphql' })
    const both = sdl.configure({ number: 'Int' })
    expect(sdl).not.toBe(graphql)
    expect(sdl.options).toEqual({ sdl: 'schema.graphql', number: 'Float', schema: false, ignoredDirectives: [] })
    expect(both.options).toEqual({ sdl: 'schema.graphql', number: 'Int', schema: false, ignoredDirectives: [] })
    expect(both.configure({ sdl: false }).options).toEqual({
      sdl: false,
      number: 'Int',
      schema: false,
      ignoredDirectives: [],
    })
    expect(graphql.options).toEqual({ sdl: false, number: 'Float', schema: false, ignoredDirectives: [] })
    expect(both.decorators).toBe(graphql.decorators)
  })

  it('takes the schema-first globs as a string or a list, false for code-first', () => {
    const schemaFirst = graphql.configure({ schema: 'src/**/*.graphql' })
    expect(schemaFirst.options.schema).toEqual(['src/**/*.graphql'])
    expect(graphql.configure({ schema: ['a/*.graphql', '!a/old.graphql'] }).options.schema).toEqual([
      'a/*.graphql',
      '!a/old.graphql',
    ])
    expect(schemaFirst.configure({ sdl: 'schema.graphql' }).options.schema).toEqual(['src/**/*.graphql'])
    expect(schemaFirst.configure({ schema: false }).options.schema).toBe(false)
  })

  it('takes the names of the custom directives kept for other tools', () => {
    const ignoring = graphql.configure({ ignoredDirectives: ['resolved', 'key'] })
    expect(ignoring.options.ignoredDirectives).toEqual(['resolved', 'key'])
    expect(ignoring.configure({ sdl: 'schema.graphql' }).options.ignoredDirectives).toEqual(['resolved', 'key'])
    expect(ignoring.configure({ ignoredDirectives: [] }).options.ignoredDirectives).toEqual([])
  })

  it('rejects invalid options', () => {
    expect(() => graphql.configure(null as never)).toThrow('graphql.configure() expects an options object')
    expect(() => graphql.configure({ schemas: 'x' } as never)).toThrow('unknown option "schemas"')
    expect(() => graphql.configure({ schema: '' })).toThrow('"schema" must be a glob or a non-empty list of globs')
    expect(() => graphql.configure({ schema: [] })).toThrow('"schema" must be a glob')
    expect(() => graphql.configure({ schema: true as never })).toThrow('"schema" must be a glob')
    expect(() => graphql.configure({ sdl: '' })).toThrow('"sdl" must be a path relative to the project root')
    expect(() => graphql.configure({ sdl: true as never })).toThrow('"sdl" must be a path')
    expect(() => graphql.configure({ number: 'Double' as never })).toThrow(`"number" must be 'Float' or 'Int'`)
    expect(() => graphql.configure({ ignoredDirectives: ['@resolved'] })).toThrow(
      '"ignoredDirectives" must be a list of directive names without @',
    )
    expect(() => graphql.configure({ ignoredDirectives: 'resolved' as never })).toThrow('"ignoredDirectives" must be')
  })
})

describe('the SDL artifact', () => {
  it('is not written by default', async () => {
    const app = tempApp(CATALOG)
    const result = await compileApp(app.root)
    expect(result.extraFiles).toEqual([])
  })

  it('is written next to the generated module at the configured path, with a final newline', async () => {
    const app = tempApp(CATALOG)
    const result = await compileApp(app.root, {
      extensions: [graphql.configure({ sdl: 'graphql/schema.graphql' }) as never],
    })
    expect(result.extraFiles.map(file => [file.file, file.extension])).toEqual([
      [app.path('graphql/schema.graphql'), 'graphql'],
    ])
    const content = result.extraFiles[0]?.content ?? ''
    expect(content.startsWith('type Author {\n')).toBe(true)
    expect(content.endsWith('}\n')).toBe(true)
  })

  it('is refused outside the project (ZNIGHT018)', async () => {
    const app = tempApp(CATALOG)
    const result = await compileApp(app.root, {
      extensions: [graphql.configure({ sdl: '../schema.graphql' }) as never],
    })
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['ZNIGHT018'])
  })
})
