/**
 * Compiler support of RFC 0006 (§5): `@Cookie`, `@SignedCookie` and `@Sse` are analysed, generated
 * (invoke arguments, `sse` metadata) and diagnosed (ZNIGHT005, ZNIGHT007, ZNIGHT017).
 */
import type { GenNode } from '@znight/compiler'

import { analyzeApp, cleanupApps, generateSection, httpDiagnostics, print, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const IMPORTS = `import {
  Body, Controller, Cookie, Ctx, Get, Header, HttpCode, type HttpContext, HttpResponse, Param, Post, Res,
  SignedCookie, Sse, type SseEvent, UploadedFile,
} from '@znight/http'
import { z } from 'zod'
`

/** Line of `src/app.ts` for a source line (the shared imports take 5 lines). */
const L = (line: number): number => line + 5

async function diagnose(source: string, options: { strictValidation?: boolean } = {}): Promise<string[]> {
  const app = tempApp({ 'src/app.ts': `${IMPORTS}${source}` })
  return httpDiagnostics(await analyzeApp(app.root, options))
}

async function generate(source: string): Promise<{ readonly code: string; readonly routes: Map<string, GenNode>[] }> {
  const app = tempApp({ 'src/app.ts': `${IMPORTS}${source}` })
  const analysis = await analyzeApp(app.root)
  expect(httpDiagnostics(analysis).filter(line => line.startsWith('error'))).toEqual([])
  const section = generateSection(analysis)
  const controllers = items(entries(section.node).get('controllers')).map(entries)
  const routes = controllers.flatMap(controller => items(controller.get('routes')).map(entries))
  return { code: section.code, routes }
}

function entries(node: GenNode | undefined): Map<string, GenNode> {
  if (node?.kind !== 'gen:object') throw new Error(`expected an object node, got ${node?.kind}`)
  return new Map(node.entries)
}

function items(node: GenNode | undefined): readonly GenNode[] {
  if (node?.kind !== 'gen:array') throw new Error(`expected an array node, got ${node?.kind}`)
  return node.items
}

function routeOf(routes: Map<string, GenNode>[], handler: string): Map<string, GenNode> {
  const found = routes.find(route => {
    const node = route.get('handler')
    return node?.kind === 'gen:literal' && node.value === handler
  })
  if (found === undefined) throw new Error(`no route ${handler}`)
  return found
}

const invoke = (routes: Map<string, GenNode>[], handler: string): string =>
  print(routeOf(routes, handler).get('invoke') as GenNode)

describe('@Cookie and @SignedCookie', () => {
  const SOURCE = `
export const Theme = z.enum(['light', 'dark']).catch('light')
export const Cookies = z.object({ a: z.string() })
export enum Level { Low = 'low', High = 'high' }

@Controller('/prefs')
export class PrefsController {
  @Get('/coerced')
  coerced(@Cookie('visits') visits: number, @Cookie('since') since: Date, @Cookie('level') level: Level, @Cookie('mode') mode: 'a' | 'b') {
    return { visits, since, level, mode }
  }
  @Get('/optional')
  optional(@Cookie('visits') visits = 0, @Cookie('name') name?: string) {
    return { visits, name }
  }
  @Get('/schema')
  schema(@Cookie('theme', Theme) theme: 'light' | 'dark') {
    return theme
  }
  @Get('/all')
  all(@Cookie() cookies: Record<string, string>, @Cookie(Cookies) parsed: { a: string }) {
    return { cookies, parsed }
  }
  @Get('/signed')
  signed(@SignedCookie('__Host-uid') uid: string, @SignedCookie('n') n?: number, @SignedCookie('s', Theme) s?: string) {
    return { uid, n, s }
  }
}
`

  it('generates the invoke arguments of RFC 0006 §5.4', async () => {
    const { routes, code } = await generate(SOURCE)
    expect(invoke(routes, 'coerced')).toBe(
      `(c: PrefsController, ctx: HttpContext) => c.coerced(coerce.number(ctx.cookies['visits'], 'cookie "visits"'), coerce.date(ctx.cookies['since'], 'cookie "since"'), coerce.enum(ctx.cookies['level'], 'cookie "level"', ['low', 'high']) as never, coerce.enum(ctx.cookies['mode'], 'cookie "mode"', ['a', 'b']))`,
    )
    expect(invoke(routes, 'optional')).toBe(
      `(c: PrefsController, ctx: HttpContext) => c.optional(coerce.optional(ctx.cookies['visits'], 'cookie "visits"', coerce.number), coerce.optional(ctx.cookies['name'], 'cookie "name"', coerce.string))`,
    )
    expect(invoke(routes, 'schema')).toBe(
      `async (c: PrefsController, ctx: HttpContext) => c.schema(await validate(Theme, ctx.cookies['theme'], 'cookie "theme"'))`,
    )
    expect(invoke(routes, 'all')).toBe(
      `async (c: PrefsController, ctx: HttpContext) => c.all(ctx.cookies as never, await validate(Cookies, ctx.cookies, 'cookies'))`,
    )
    expect(invoke(routes, 'signed')).toBe(
      `async (c: PrefsController, ctx: HttpContext) => c.signed(coerce.string(ctx.signedCookie('__Host-uid'), 'cookie "__Host-uid"'), coerce.optional(ctx.signedCookie('n'), 'cookie "n"', coerce.number), await validate(Theme, ctx.signedCookie('s'), 'cookie "s"'))`,
    )
    expect(code).not.toContain('sse:')
  })

  it('records the params metadata', async () => {
    const { routes } = await generate(SOURCE)
    expect(print(routeOf(routes, 'signed').get('params') as GenNode)).toBe(`[
  {
    index: 0,
    source: 'signedCookie',
    name: '__Host-uid',
    type: 'string',
  },
  {
    index: 1,
    source: 'signedCookie',
    name: 'n',
    type: 'number',
    optional: true,
  },
  {
    index: 2,
    source: 'signedCookie',
    name: 's',
    optional: true,
    schema: true,
  },
]`)
    expect(print(routeOf(routes, 'all').get('params') as GenNode)).toBe(`[
  {
    index: 0,
    source: 'cookie',
  },
  {
    index: 1,
    source: 'cookie',
    schema: true,
  },
]`)
  })

  it('reports invalid names, a nameless @SignedCookie and two decorators (ZNIGHT005)', async () => {
    expect(
      await diagnose(`
@Controller()
export class C {
  @Get('/a')
  a(@Cookie('a b') x: string, @Cookie('') y: string, @SignedCookie('é') z2: string) {}
  @Get('/b')
  b(@Cookie('x') @SignedCookie('x') x: string) {}
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(5)}:13 @Cookie: invalid cookie name "a b"`,
      `error ZNIGHT005 src/app.ts:${L(5)}:39 @Cookie expects a name (non-empty string) or a schema, got ""`,
      `error ZNIGHT005 src/app.ts:${L(5)}:68 @SignedCookie: invalid cookie name "é"`,
      `error ZNIGHT005 src/app.ts:${L(7)}:18 Parameter 'x' of C.b has several HTTP decorators`,
    ])
  })

  it('reports a schema reference given to @SignedCookie without name', async () => {
    expect(
      await diagnose(`
export const S = z.string()
@Controller()
export class C {
  @Get('/a')
  a(@SignedCookie(S) y: string) {}
}
`),
    ).toEqual([`error ZNIGHT005 src/app.ts:${L(6)}:5 @SignedCookie requires a cookie name`])
  })

  it('reports types that cannot be coerced (ZNIGHT007)', async () => {
    expect(
      await diagnose(`
@Controller()
export class C {
  @Get('/a')
  a(@Cookie('o') o: { a: string }, @SignedCookie('u') u: string | number) {}
}
`),
    ).toEqual([
      `error ZNIGHT007 src/app.ts:${L(5)}:21 Invalid cookie "o" of C.a: type '{ a: string }' cannot be coerced (this type cannot be read from a request value)`,
      `error ZNIGHT007 src/app.ts:${L(5)}:58 Invalid cookie "u" of C.a: type 'number | string' cannot be coerced (only unions of literal types can be coerced)`,
    ])
  })

  it('reports a whole-record @Cookie() without schema typed otherwise (ZNIGHT017)', async () => {
    const source = `
@Controller()
export class C {
  @Get('/a')
  a(@Cookie() all: { session: string }, @Cookie() ok: Record<string, string>, @Cookie() raw: unknown) {}
}
`
    expect(await diagnose(source)).toEqual([
      `warning ZNIGHT017 src/app.ts:${L(5)}:5 Unvalidated input: the cookies of C.a ('all', typed { session: string }) has no schema`,
    ])
    expect(await diagnose(source, { strictValidation: true })).toEqual([
      `error ZNIGHT017 src/app.ts:${L(5)}:5 Unvalidated input: the cookies of C.a ('all', typed { session: string }) has no schema`,
    ])
  })

  it('lists @Cookie() in the hint of an undecorated parameter', async () => {
    const [line] = await diagnose(`
@Controller()
export class C {
  @Get('/a')
  a(x: string) {}
}
`)
    expect(line).toContain("Parameter 'x' of C.a has no HTTP decorator")
  })
})

describe('@Sse', () => {
  it('declares GET routes with their sse metadata', async () => {
    const { routes } = await generate(`
@Controller('/orders')
export class OrderEventsController {
  @Sse('/:id/events', { retry: 5_000, maxDuration: 30 * 60_000 })
  async events(@Param('id') id: string, @Ctx() ctx: HttpContext): Promise<AsyncIterable<SseEvent<{ id: string }>> | HttpResponse> {
    return [{ data: { id } }] as never
  }
  @Sse('/clock', { heartbeat: false })
  async *clock(): AsyncGenerator<SseEvent> {
    yield { data: 1 }
  }
  @Sse({ heartbeat: 15_000 })
  root(): SseEvent[] {
    return []
  }
}

@Controller('/plain')
export class PlainEventsController {
  @Sse()
  plain() {
    return [{ data: 1 }]
  }
}
`)
    const events = routeOf(routes, 'events')
    expect(print(events.get('method') as GenNode)).toBe("'GET'")
    expect(print(events.get('fullPath') as GenNode)).toBe("'/orders/:id/events'")
    expect(print(events.get('sse') as GenNode)).toBe(`{
  retry: 5000,
  maxDuration: 1800000,
}`)
    expect(print(routeOf(routes, 'clock').get('sse') as GenNode)).toBe(`{
  heartbeat: 0,
}`)
    expect(print(routeOf(routes, 'root').get('path') as GenNode)).toBe("'/'")
    expect(print(routeOf(routes, 'root').get('sse') as GenNode)).toBe(`{
  heartbeat: 15000,
}`)
    expect(print(routeOf(routes, 'plain').get('fullPath') as GenNode)).toBe("'/plain'")
    expect(print(routeOf(routes, 'plain').get('sse') as GenNode)).toBe('{}')
    // `sse` comes right before invoke
    expect([...events.keys()].slice(-2)).toEqual(['sse', 'invoke'])
  })

  it('reports misuse (ZNIGHT005)', async () => {
    expect(
      await diagnose(`
@Controller()
export class C {
  @Sse('/a')
  @Sse('/b')
  twice() { return [] }
  @Sse('/c')
  @Get('/d')
  mixed() { return [] }
  @Sse('/e')
  @HttpCode(202)
  code() { return [] }
  @Sse('/f')
  @Header('Content-Type', 'text/plain')
  @Header('x-ok', '1')
  type() { return [] }
  @Sse('/g')
  raw(@Res() res: unknown) {}
  @Sse('/h')
  async text(): Promise<string> { return '' }
  @Sse('/i')
  maybe(): SseEvent[] | undefined { return [] }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(5)}:3 @Sse is applied several times to C.twice`,
      `error ZNIGHT005 src/app.ts:${L(8)}:3 @Get cannot be combined with @Sse on C.mixed`,
      `error ZNIGHT005 src/app.ts:${L(11)}:3 @HttpCode has no effect on @Sse route C.code: an event stream answers 200`,
      `error ZNIGHT005 src/app.ts:${L(14)}:3 @Header('content-type') has no effect on @Sse route C.type`,
      `error ZNIGHT005 src/app.ts:${L(18)}:7 @Res() cannot be used on @Sse route C.raw: the plugin writes the event stream`,
      `warning ZNIGHT005 src/app.ts:${L(18)}:7 @Res() makes C.raw adapter-specific: the handler writes the native response itself`,
      `error ZNIGHT005 src/app.ts:${L(20)}:9 @Sse handler C.text returns string: return an AsyncIterable, an Iterable or a ReadableStream of SseEvent (or an HttpResponse)`,
      `error ZNIGHT005 src/app.ts:${L(22)}:3 @Sse handler C.maybe returns SseEvent<unknown>[] | undefined: return an AsyncIterable, an Iterable or a ReadableStream of SseEvent (or an HttpResponse)`,
    ])
  })

  it('reports invalid options (ZNIGHT005)', async () => {
    expect(
      await diagnose(`
@Controller()
export class C {
  @Sse('/a', { heartbeat: 500, retry: -1, maxDuration: 10, ping: true })
  a() { return [] }
  @Sse({ retry: 1 }, { retry: 2 })
  b() { return [] }
  @Sse(42)
  c() { return [] }
  @Sse('/d', 'x')
  d() { return [] }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(4)}:14 @Sse: "heartbeat" must be an integer number of ms from 1000 to 2147483647, or false, got 500`,
      `error ZNIGHT005 src/app.ts:${L(4)}:14 @Sse: "maxDuration" must be an integer number of ms from 1000 to 2147483647 (about 24.8 days), got 10`,
      `error ZNIGHT005 src/app.ts:${L(4)}:14 @Sse: "retry" must be an integer number of ms ≥ 0, got -1`,
      `error ZNIGHT005 src/app.ts:${L(4)}:14 @Sse: unknown option "ping"`,
      `error ZNIGHT005 src/app.ts:${L(6)}:22 @Sse(options) takes a single argument`,
      `error ZNIGHT005 src/app.ts:${L(8)}:8 @Sse expects a path (string) or options, got 42`,
      `error ZNIGHT005 src/app.ts:${L(10)}:14 @Sse options must be an object { heartbeat?: number | false, retry?: number, maxDuration?: number }, got "x"`,
    ])
  })

  it('reports timers above the longest setTimeout delay (ZNIGHT005)', async () => {
    expect(
      await diagnose(`
@Controller()
export class C {
  @Sse('/a', { maxDuration: 30 * 24 * 3_600_000, heartbeat: 2_147_483_648 })
  a() { return [] }
  @Sse('/b', { maxDuration: 2_147_483_647, heartbeat: 2_147_483_647 })
  b() { return [] }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(4)}:14 @Sse: "heartbeat" must be an integer number of ms from 1000 to 2147483647, or false, got 2147483648`,
      `error ZNIGHT005 src/app.ts:${L(4)}:14 @Sse: "maxDuration" must be an integer number of ms from 1000 to 2147483647 (about 24.8 days), got 2592000000`,
    ])
  })

  it('warns about request bodies on @Sse routes', async () => {
    expect(
      await diagnose(`
export const Input = z.object({ a: z.string() })
@Controller()
export class C {
  @Sse('/a')
  a(@Body(Input) input: { a: string }) { return [] }
  @Sse('/b')
  b(@UploadedFile('f') f: File) { return [] }
}
`),
    ).toEqual([
      `warning ZNIGHT005 src/app.ts:${L(6)}:5 @Sse route C.a reads a request body: EventSource sends GET requests without body`,
      `warning ZNIGHT005 src/app.ts:${L(7)}:3 C.b reads uploaded files but is a GET route: GET requests usually have no body`,
      `warning ZNIGHT005 src/app.ts:${L(8)}:5 @Sse route C.b reads a request body: EventSource sends GET requests without body`,
    ])
  })

  it('accepts references, generators, unions with HttpResponse and opaque return types', async () => {
    expect(
      await diagnose(`
@Controller()
export class C {
  @Sse('/a')
  async a(): Promise<AsyncIterable<SseEvent> | HttpResponse> { return [] as never }
  @Sse('/b')
  *b(): Generator<SseEvent> { yield { data: 1 } }
  @Sse('/c')
  c(): ReadableStream<SseEvent> { return new ReadableStream() }
  @Sse('/d')
  d(): unknown { return [] }
  @Sse('/e')
  e<T>(): T { return [] as T }
}
`),
    ).toEqual([])
  })

  it('reports duplicate routes with GET routes (ZNIGHT007)', async () => {
    expect(
      await diagnose(`
@Controller()
export class C {
  @Get('/x')
  a() { return 1 }
  @Sse('/x')
  b() { return [] }
}
`),
    ).toEqual([`error ZNIGHT007 src/app.ts:${L(6)}:3 Duplicate route GET /x: C.b conflicts with C.a (GET /x)`])
  })

  it('reports @Sse outside of a controller', async () => {
    expect(
      await diagnose(`
export class NotAController {
  @Sse('/x')
  b() { return [] }
}
`),
    ).toEqual([`error ZNIGHT005 src/app.ts:${L(3)}:3 @Sse has no effect: NotAController is not a controller`])
  })
})
