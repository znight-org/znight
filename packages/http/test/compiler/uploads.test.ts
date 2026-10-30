/**
 * `@UploadedFile`, `@UploadedFiles` and `@BodyLimit` in the compiler extension: analysis, generated
 * metadata and `invoke` code, and diagnostics (ZNIGHT005 / ZNIGHT017).
 */
import type { GenNode } from '@znight/compiler'

import { analyzeApp, cleanupApps, generateSection, httpDiagnostics, print, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const IMPORTS = `import { Body, BodyLimit, Controller, Ctx, Delete, Get, Post, Put, Patch, All, UploadedFile, UploadedFiles } from '@znight/http'
import type { HttpContext } from '@znight/http'
import { File as NodeFile } from 'node:buffer'
import { z } from 'zod'
`

/** Line of `src/app.ts` for a source line (the shared imports take 4 lines). */
const L = (line: number): number => line + 4

async function diagnose(source: string): Promise<string[]> {
  const app = tempApp({ 'src/app.ts': `${IMPORTS}${source}` })
  return httpDiagnostics(await analyzeApp(app.root))
}

const VALID = `
export const Meta = z.object({ title: z.string() })
const MAX = '2mb'
@Controller('/files')
@BodyLimit('50mb')
export class FilesController {
  @Post('/avatar')
  avatar(@UploadedFile('avatar', { maxSize: MAX, mimeTypes: ['image/png', 'image/*'] }) avatar: File, @Body(Meta) meta: z.output<typeof Meta>) { return [avatar, meta] }
  @Post('/optional')
  optional(@UploadedFile('file') file?: File) { return file }
  @Post('/nullable')
  nullable(@UploadedFile('file', { required: false }) file: File | null) { return file }
  @Put('/docs')
  @BodyLimit(1024)
  docs(@UploadedFiles('docs', { maxFiles: 5, maxSize: 1000, required: false }) docs: File[]) { return docs }
  @Patch('/all')
  all(@UploadedFiles() files: readonly File[]) { return files }
  @Post('/any')
  any(@UploadedFile({ required: true }) file: Blob) { return file }
  @Post('/any-files')
  anyFiles(@UploadedFiles(undefined, { maxFiles: 3 }) files?: unknown) { return files }
  @Post('/node')
  node(@UploadedFile('f', { maxSize: Infinity }) f: NodeFile) { return f }
  @Post('/fields')
  fields(@UploadedFile('f') f: File, @Body() fields: Record<string, string | string[]>) { return [f, fields] }
  @Post('/untyped')
  untyped(@UploadedFile('f') f) { return f }
  @Put('/raw')
  @BodyLimit(Infinity)
  raw(@Ctx() ctx: HttpContext) { return ctx.bodyStream() }
  @All('/all-methods')
  everything(@UploadedFile('f') f: File) { return f }
}
`

describe('valid uploads', () => {
  let section: ReturnType<typeof generateSection>

  it('analyses without diagnostics', async () => {
    const app = tempApp({ 'src/app.ts': `${IMPORTS}${VALID}` })
    const result = await analyzeApp(app.root)
    section = generateSection(result)
    expect(httpDiagnostics(result)).toEqual([])
    expect(section.diagnostics).toEqual([])
    expect(section.imports).toEqual([
      'isThenable from @znight/http',
      'type HttpContext from @znight/http',
      'type src/app.ts#FilesController',
      'uploads from @znight/http',
      'validate from @znight/http',
    ])
  })

  function route(handler: string): Map<string, GenNode> {
    const root = section.node
    if (root?.kind !== 'gen:object') throw new Error('no section')
    const controllers = root.entries[0]?.[1]
    if (controllers?.kind !== 'gen:array') throw new Error('no controllers')
    const controller = controllers.items[0]
    if (controller?.kind !== 'gen:object') throw new Error('no controller')
    const routes = new Map(controller.entries).get('routes')
    if (routes?.kind !== 'gen:array') throw new Error('no routes')
    for (const item of routes.items) {
      if (item.kind !== 'gen:object') continue
      const entries = new Map(item.entries)
      const name = entries.get('handler')
      if (name?.kind === 'gen:literal' && name.value === handler) return entries
    }
    throw new Error(`no route ${handler}`)
  }

  const invoke = (handler: string): string => print(route(handler).get('invoke') as GenNode)
  const field = (handler: string, key: string): string | undefined => {
    const node = route(handler).get(key)
    return node === undefined ? undefined : print(node)
  }

  it('generates invoke calls with the uploads helpers', () => {
    expect(invoke('avatar')).toBe(
      [
        '(c: FilesController, ctx: HttpContext) => {',
        "  const a0 = uploads.file(ctx, 'avatar')",
        "  const a1 = validate(Meta, ctx.body, 'body')",
        '  if (isThenable(a1)) return (async () => c.avatar(a0, await a1))()',
        '  return c.avatar(a0, a1)',
        '}',
      ].join('\n'),
    )
    expect(invoke('optional')).toBe(
      "(c: FilesController, ctx: HttpContext) => c.optional(uploads.optionalFile(ctx, 'file'))",
    )
    expect(invoke('nullable')).toBe(
      "(c: FilesController, ctx: HttpContext) => c.nullable(uploads.optionalFile(ctx, 'file') as never)",
    )
    expect(invoke('docs')).toBe("(c: FilesController, ctx: HttpContext) => c.docs(uploads.optionalFiles(ctx, 'docs'))")
    expect(invoke('all')).toBe('(c: FilesController, ctx: HttpContext) => c.all(uploads.files(ctx, undefined))')
    expect(invoke('node')).toBe("(c: FilesController, ctx: HttpContext) => c.node(uploads.file(ctx, 'f') as never)")
    expect(invoke('fields')).toBe(
      "(c: FilesController, ctx: HttpContext) => c.fields(uploads.file(ctx, 'f'), ctx.body as never)",
    )
    expect(invoke('untyped')).toBe("(c: FilesController, ctx: HttpContext) => c.untyped(uploads.file(ctx, 'f'))")
    expect(invoke('any')).toBe('(c: FilesController, ctx: HttpContext) => c.any(uploads.file(ctx, undefined))')
    expect(invoke('anyFiles')).toBe(
      '(c: FilesController, ctx: HttpContext) => c.anyFiles(uploads.optionalFiles(ctx, undefined))',
    )
    expect(invoke('raw')).toBe('(c: FilesController, ctx: HttpContext) => c.raw(ctx)')
    expect(invoke('everything')).toBe("(c: FilesController, ctx: HttpContext) => c.everything(uploads.file(ctx, 'f'))")
  })

  it('emits the upload rules, the body limits and the parameter sources', () => {
    expect(field('avatar', 'uploads')).toBe(
      "[\n  {\n    field: 'avatar',\n    required: true,\n    maxSize: 2097152,\n    mimeTypes: ['image/png', 'image/*'],\n  },\n]",
    )
    expect(field('avatar', 'bodyLimit')).toBe('52428800')
    expect(field('avatar', 'params')).toBe(
      "[\n  {\n    index: 0,\n    source: 'file',\n    name: 'avatar',\n  },\n  {\n    index: 1,\n    source: 'body',\n    schema: true,\n  },\n]",
    )
    expect(field('optional', 'uploads')).toBe("[\n  {\n    field: 'file',\n  },\n]")
    expect(field('optional', 'params')).toBe(
      "[\n  {\n    index: 0,\n    source: 'file',\n    name: 'file',\n    optional: true,\n  },\n]",
    )
    expect(field('docs', 'uploads')).toBe(
      "[\n  {\n    field: 'docs',\n    multiple: true,\n    maxSize: 1000,\n    maxFiles: 5,\n  },\n]",
    )
    expect(field('docs', 'bodyLimit')).toBe('1024')
    expect(field('all', 'uploads')).toBe('[\n  {\n    multiple: true,\n    required: true,\n  },\n]')
    expect(field('node', 'uploads')).toBe(
      "[\n  {\n    field: 'f',\n    required: true,\n    maxSize: Infinity,\n  },\n]",
    )
    expect(field('raw', 'bodyLimit')).toBe('Infinity')
    expect(field('raw', 'uploads')).toBeUndefined()
    expect([...route('avatar').keys()]).toEqual([
      'method',
      'path',
      'fullPath',
      'handler',
      'meta',
      'guards',
      'interceptors',
      'params',
      'bodyLimit',
      'uploads',
      'invoke',
    ])
  })
})

describe('diagnostics', () => {
  it('parameter types', async () => {
    expect(
      await diagnose(`
@Controller('/t')
export class T {
  @Post('/a') a(@UploadedFile('a') a: string) { return a }
  @Post('/b') b(@UploadedFiles('b') b: File) { return b }
  @Post('/c') c(@UploadedFile('c') c: File[]) { return c }
  @Post('/d') d(@UploadedFile('d', { required: false }) d: File) { return d }
  @Post('/e') e(@UploadedFiles('e') e: unknown[], @UploadedFile('f') f: any) { return [e, f] }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(4)}:39 @UploadedFile parameter 'a' of T.a must be typed File, got string`,
      `error ZNIGHT005 src/app.ts:${L(5)}:40 @UploadedFiles parameter 'b' of T.b must be typed File[], got File`,
      `error ZNIGHT005 src/app.ts:${L(6)}:39 @UploadedFile parameter 'c' of T.c must be typed File, got File[]`,
      `error ZNIGHT005 src/app.ts:${L(7)}:36 @UploadedFile: 'd' of T.d is optional ({ required: false }) but typed File`,
    ])
  })

  it('arguments and options', async () => {
    expect(
      await diagnose(`
@Controller('/o')
export class O {
  @Post('/a') a(@UploadedFile('a', { maxFiles: 2 }) a: File) { return a }
  @Post('/b') b(@UploadedFile('b', { maxSize: '5 parsecs' }) b: File) { return b }
  @Post('/c') c(@UploadedFile('c', { mimeTypes: ['image', 'text/plain'] }) c: File) { return c }
  @Post('/d') d(@UploadedFile('d', { mimeTypes: [] }) d: File) { return d }
  @Post('/e') e(@UploadedFile('e', { unknown: 1 }) e: File) { return e }
  @Post('/f') f(@UploadedFile('') f: File) { return f }
  @Post('/g') g(@UploadedFile(42) g: File) { return g }
  @Post('/h') h(@UploadedFile({ maxSize: 1 }, {}) h: File) { return h }
  @Post('/i') i(@UploadedFiles('i', { maxFiles: 0 }) i: File[]) { return i }
  @Post('/j') j(@UploadedFile('j', { required: 'yes' }) j: File) { return j }
  @Post('/k') k(@UploadedFile('k', 'nope') k: File) { return k }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(4)}:36 @UploadedFile: "maxFiles" only applies to @UploadedFiles (a single file is expected here)`,
      `error ZNIGHT005 src/app.ts:${L(5)}:36 @UploadedFile: "maxSize" must be a size in bytes, got "5 parsecs"`,
      `error ZNIGHT005 src/app.ts:${L(6)}:36 @UploadedFile: invalid media type "image" in "mimeTypes"`,
      `error ZNIGHT005 src/app.ts:${L(7)}:36 @UploadedFile: "mimeTypes" must be a non-empty array of media types, got an array`,
      `error ZNIGHT005 src/app.ts:${L(8)}:36 @UploadedFile: unknown option "unknown"`,
      `error ZNIGHT005 src/app.ts:${L(9)}:31 @UploadedFile expects a non-empty field name`,
      `error ZNIGHT005 src/app.ts:${L(10)}:31 @UploadedFile expects a field name (string) or options, got 42`,
      `error ZNIGHT005 src/app.ts:${L(11)}:47 @UploadedFile(options) takes a single argument`,
      `error ZNIGHT005 src/app.ts:${L(12)}:37 @UploadedFiles: "maxFiles" must be a positive integer, got 0`,
      `error ZNIGHT005 src/app.ts:${L(13)}:36 @UploadedFile: "required" must be a boolean, got "yes"`,
      `error ZNIGHT005 src/app.ts:${L(14)}:36 @UploadedFile options must be an object { required?, maxSize?, mimeTypes? }, got "nope"`,
    ])
  })

  it('several upload parameters of a handler', async () => {
    expect(
      await diagnose(`
@Controller('/m')
export class M {
  @Post('/a') a(@UploadedFile('x') a: File, @UploadedFiles('x') b: File[]) { return [a, b] }
  @Post('/b') b(@UploadedFile('x') a: File, @UploadedFiles() b: File[]) { return [a, b] }
  @Post('/c') c(@UploadedFile('x') a: File, @UploadedFile('y') b: File, @Body() fields: Record<string, string>) { return [a, b, fields] }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(4)}:45 The field "x" of M.a is read by several upload parameters`,
      `error ZNIGHT005 src/app.ts:${L(5)}:45 M.b: an upload parameter without field receives every file of the body and cannot be combined with other upload parameters`,
    ])
  })

  it('upload parameters on routes without body (warning)', async () => {
    expect(
      await diagnose(`
@Controller('/w')
export class W {
  @Get('/a') @Delete('/a') @Post('/a') a(@UploadedFile('f') f: File) { return f }
}
`),
    ).toEqual([
      `warning ZNIGHT005 src/app.ts:${L(4)}:3 W.a reads uploaded files but is a GET route: GET requests usually have no body`,
      `warning ZNIGHT005 src/app.ts:${L(4)}:14 W.a reads uploaded files but is a DELETE route: DELETE requests usually have no body`,
    ])
  })

  it('@BodyLimit', async () => {
    expect(
      await diagnose(`
@Controller('/l')
@BodyLimit('big')
export class Limits {
  @Post('/a') @BodyLimit() a() {}
  @Post('/b') @BodyLimit(1) @BodyLimit(2) b() {}
  @Post('/c') @BodyLimit(-1) c() {}
  @BodyLimit('1kb') helper() {}
}
export class NotAController {
  @BodyLimit('1kb') m() {}
}
@BodyLimit(1)
export class AlsoNot {}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(3)}:12 @BodyLimit expects a size in bytes, got "big"`,
      `error ZNIGHT005 src/app.ts:${L(5)}:15 @BodyLimit requires a size`,
      `error ZNIGHT005 src/app.ts:${L(6)}:29 @BodyLimit is applied several times`,
      `error ZNIGHT005 src/app.ts:${L(7)}:26 @BodyLimit expects a size in bytes, got -1`,
      `error ZNIGHT005 src/app.ts:${L(8)}:3 @BodyLimit has no effect: Limits.helper is not a route`,
      `error ZNIGHT005 src/app.ts:${L(11)}:3 @BodyLimit has no effect: NotAController is not a controller`,
      `error ZNIGHT005 src/app.ts:${L(13)}:1 @BodyLimit has no effect: AlsoNot is not a controller`,
    ])
  })

  it('upload decorators outside routes and on wrong targets', async () => {
    expect(
      await diagnose(`
@Controller('/x')
export class X {
  constructor(@UploadedFile('f') readonly f: File) {}
  helper(@UploadedFiles('g') g: File[]) { return g }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(4)}:15 @UploadedFile cannot be applied to a constructor parameter (allowed on a method parameter)`,
      `error ZNIGHT005 src/app.ts:${L(5)}:10 @UploadedFiles has no effect: X.helper is not a route`,
    ])
  })

  it('accepts the text-field record of a multipart body without schema (no ZNIGHT017)', async () => {
    expect(
      await diagnose(`
@Controller('/r')
export class R {
  @Post('/a') a(@UploadedFile('f') f: File, @Body() fields: Record<string, string | string[]>) { return [f, fields] }
  @Post('/b') b(@UploadedFile('f') f: File, @Body() fields: { title: string }) { return [f, fields] }
}
`),
    ).toEqual([
      `warning ZNIGHT017 src/app.ts:${L(5)}:45 Unvalidated input: the body of R.b ('fields', typed { title: string }) has no schema`,
    ])
  })
})
