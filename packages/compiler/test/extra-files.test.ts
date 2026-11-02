/**
 * Extra outputs (`GenerateContext.emitFile`, §6.5): files emitted by compiler extensions are part of
 * the compile result (`extraFiles`), written with the generated module only when the compile is ok
 * and their content changed, compared by check mode (`staleFiles`), ignored by the watchers, and
 * their paths are validated (ZNIGHT018).
 */
import type { CompilerExtension, GenerateContext } from '../src/index.ts'

import fs from 'node:fs'

import { compile, createCompiler, generate, generatedFiles } from '../src/compiler.ts'
import { includeRoots, isGeneratedFile, isRelevantChange } from '../src/watch.ts'
import { tempApp } from './analysis/helpers.ts'
import { render } from './codegen/helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const SERVICE = `import { Injectable } from '@znight/core'
@Injectable()
export class Service {}
`

const BROKEN = `import { Injectable } from '@znight/core'
import type { Missing } from './nope.ts'
@Injectable()
export class Broken { constructor(readonly missing: Missing) {} }
`

/** An extension without decorators whose `generate` only emits files. */
function emitter(emit: (ctx: GenerateContext) => void, name = 'sdl'): CompilerExtension {
  return {
    apiVersion: 1,
    name,
    decorators: {},
    generate(ctx) {
      emit(ctx)
      return undefined
    },
  }
}

const SDL = 'type Query {\n  service: String!\n}\n'

describe('emitFile()', () => {
  const app = tempApp({ 'src/service.ts': SERVICE })
  afterAll(() => app.cleanup())
  const base = { root: app.root, conditions: ['@znight/source'] }
  const outFile = `${app.root}/src/.znight/container.generated.ts`
  const schema = `${app.root}/schema.graphql`
  let sdl = SDL
  const options = { ...base, extensions: [emitter(ctx => ctx.emitFile('schema.graphql', sdl))] }

  it('reports the extra files in the compile result, without writing them', async () => {
    const result = await compile(options)
    expect(render(app.root, result.diagnostics)).toBe('')
    expect(result.extraFiles).toEqual([{ file: schema, content: SDL, extension: 'sdl' }])
    expect(fs.existsSync(schema)).toBe(false)
    expect(result.watchFiles).not.toContain(schema)
    // the generated module does not change
    expect(result.code).toBe((await compile({ ...base, extensions: [emitter(() => undefined)] })).code)
    expect((await compile(base)).extraFiles).toEqual([])
  })

  it('are the same in every mode, rendered once (the disk copy)', async () => {
    const build = await compile({ ...options, mode: 'build' })
    expect(render(app.root, build.diagnostics)).toBe('')
    expect(build.extraFiles).toEqual((await compile({ ...options, mode: 'test' })).extraFiles)
    expect(build.extraFiles).toEqual((await compile(options)).extraFiles)
  })

  it('are written with the module, only when their content changed', async () => {
    const check = await generate({ ...options, check: true })
    expect(check).toMatchObject({ stale: true, staleFiles: [outFile, schema], written: [] })
    expect(fs.existsSync(schema)).toBe(false)

    const first = await generate(options)
    expect(first.written).toEqual([outFile, schema])
    expect(fs.readFileSync(schema, 'utf8')).toBe(SDL)
    const stat = fs.statSync(schema)
    expect(await generate({ ...options, check: true })).toMatchObject({ stale: false, staleFiles: [] })

    const second = await generate(options)
    expect(second.written).toEqual([])
    expect(fs.statSync(schema).mtimeMs).toBe(stat.mtimeMs)
    // no temporary file left behind by the atomic writes
    expect(fs.readdirSync(app.root).filter(file => file.endsWith('.tmp'))).toEqual([])

    sdl = `${SDL}type Book {\n  title: String!\n}\n`
    try {
      expect(await generate({ ...options, check: true })).toMatchObject({ stale: true, staleFiles: [schema] })
      expect(fs.readFileSync(schema, 'utf8')).toBe(SDL)
      const third = await generate(options)
      expect(third.written).toEqual([schema])
      expect(fs.readFileSync(schema, 'utf8')).toBe(sdl)
    } finally {
      sdl = SDL
    }
    await generate(options)
    fs.writeFileSync(schema, 'edited by hand\n')
    expect(await generate({ ...options, check: true })).toMatchObject({ stale: true, staleFiles: [schema] })
    expect((await generate(options)).written).toEqual([schema])
  })

  it('are never written when the compile fails', async () => {
    await generate(options)
    sdl = 'type Changed\n'
    app.write('src/broken.ts', BROKEN)
    try {
      const failed = await generate(options)
      expect(failed.ok).toBe(false)
      expect(failed.extraFiles).toEqual([])
      expect(failed.written).toEqual([])
      expect(fs.readFileSync(schema, 'utf8')).toBe(SDL)
      expect(await generate({ ...options, check: true })).toMatchObject({ ok: false, stale: false, staleFiles: [] })
    } finally {
      app.remove('src/broken.ts')
      sdl = SDL
    }
  })

  it('are listed by generatedFiles(): the module, the extra files, then the library manifest', async () => {
    const result = await compile({
      ...base,
      extensions: [emitter(ctx => (ctx.emitFile('b.json', '{}\n'), ctx.emitFile('a/schema.graphql', SDL)))],
    })
    expect(generatedFiles(result).map(output => output.file)).toEqual([
      outFile,
      `${app.root}/a/schema.graphql`,
      `${app.root}/b.json`,
    ])
    expect(generatedFiles({ ...result, ok: false })).toEqual([])
  })

  it('accepts source files under a dot-directory and paths normalised inside the root', async () => {
    const result = await compile({
      ...base,
      extensions: [
        emitter(ctx => {
          ctx.emitFile('src/.znight/schema.ts', 'export const schema = 1\n')
          ctx.emitFile('docs/../api/schema.graphql', SDL)
        }),
      ],
    })
    expect(render(app.root, result.diagnostics)).toBe('')
    expect(result.extraFiles.map(extra => extra.file)).toEqual([
      `${app.root}/api/schema.graphql`,
      `${app.root}/src/.znight/schema.ts`,
    ])
  })

  it('refuses paths outside the root, of other outputs or of sources (ZNIGHT018)', async () => {
    const paths = [
      '../escape.graphql',
      'a/../../escape.graphql',
      '/tmp/absolute.graphql',
      'C:\\absolute.graphql',
      '',
      '.',
      'dir/',
      'node_modules/pkg/schema.graphql',
      'src/.znight/container.generated.ts',
      'dist/znight.providers.json',
      'src/schema.ts',
      'scripts/generated.js',
      'twice.graphql',
    ]
    const result = await compile({
      ...base,
      extensions: [
        emitter(ctx => {
          for (const file of paths) ctx.emitFile(file, SDL)
          ctx.emitFile('twice.graphql', SDL)
        }),
        emitter(ctx => ctx.emitFile('twice.graphql', SDL), 'other'),
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.extraFiles).toEqual([])
    // (diagnostics without location are sorted by message)
    expect(
      result.diagnostics.map(diagnostic => `${diagnostic.code} ${diagnostic.severity} ${diagnostic.message}`),
    ).toEqual(
      [
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "../escape.graphql": the path must stay inside the project root`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "a/../../escape.graphql": the path must stay inside the project root`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "/tmp/absolute.graphql": the path must be relative to the project root`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "C:\\\\absolute.graphql": the path must be relative to the project root`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "": the path must name a file`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file ".": the path must stay inside the project root`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "dir/": the path must name a file`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "node_modules/pkg/schema.graphql": the path cannot be inside node_modules`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "src/.znight/container.generated.ts": it is the generated module (outFile)`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "dist/znight.providers.json": it is the compiled provider library manifest`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "src/schema.ts": a source file would be scanned by the compiler: write it under a dot-directory (src/.znight/)`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "scripts/generated.js": a source file would be scanned by the compiler: write it under a dot-directory (src/.znight/)`,
        `ZNIGHT018 error Compiler extension 'sdl' cannot emit the file "twice.graphql": the extension already emitted this file`,
        `ZNIGHT018 error Compiler extension 'other' cannot emit the file "twice.graphql": extension 'sdl' already emitted this file`,
      ].sort(),
    )
    expect(result.diagnostics[0]?.hints?.[0]).toContain('relative to the project root')
  })

  it('reports a content that is not a string as a failing extension (ZNIGHT018)', async () => {
    const result = await compile({
      ...base,
      extensions: [emitter(ctx => ctx.emitFile('schema.graphql', { sdl: SDL } as never))],
    })
    expect(result.ok).toBe(false)
    expect(render(app.root, result.diagnostics)).toContain("emitFile('schema.graphql') takes a string content")
  })
})

describe('watchers and extra files', () => {
  const app = tempApp({ 'src/service.ts': SERVICE })
  afterAll(() => app.cleanup())

  it('ignore the extra files of the last result, like the generated module', async () => {
    const compiler = createCompiler({
      root: app.root,
      conditions: ['@znight/source'],
      extensions: [
        emitter(ctx => {
          ctx.emitFile('schema.graphql', SDL)
          ctx.emitFile('src/.znight/schema.ts', 'export const schema = 1\n')
        }),
      ],
    })
    const types = `${app.root}/src/.znight/schema.ts`
    const schema = `${app.root}/schema.graphql`
    const roots = includeRoots(compiler)
    const watched = new Set<string>()
    // before the first compile, the extra files are unknown
    expect(compiler.isGeneratedFile(types)).toBe(false)
    expect(isRelevantChange(compiler, 'added', types, watched, roots)).toBe(true)

    const result = await compiler.generate()
    expect(result.written).toEqual([`${app.root}/src/.znight/container.generated.ts`, schema, types])
    expect(compiler.isGeneratedFile(schema)).toBe(true)
    expect(compiler.isGeneratedFile(types)).toBe(true)
    expect(compiler.isGeneratedFile(result.outFile)).toBe(true)
    expect(compiler.isGeneratedFile(`${app.root}/src/service.ts`)).toBe(false)
    expect(compiler.isOutFile(schema)).toBe(false)
    expect(isGeneratedFile(compiler, types)).toBe(true)
    for (const kind of ['added', 'changed', 'removed'] as const) {
      expect(isRelevantChange(compiler, kind, types, watched, roots)).toBe(false)
      expect(isRelevantChange(compiler, kind, schema, new Set([schema]), roots)).toBe(false)
    }
    // a change reported for an extra file is not a source change
    const again = await compiler.generate({ changed: [schema, types] })
    expect(again.written).toEqual([])
    expect(again.stats.parsed).toBe(0)
  })
})
