/**
 * Diagnostics of the extension on invalid applications: ZNIGHT005 (decorator usage), ZNIGHT007
 * (routes), ZNIGHT017 (unvalidated input) and ZNIGHT003 (through the guard / interceptor edges).
 */
import type { Diagnostic } from '@znight/compiler'

import fs from 'node:fs'
import path from 'node:path'

import { analyzeApp, cleanupApps, HTTP_ROOT, httpDiagnostics, render, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const IMPORTS = `import {
  All, Body, Controller, Ctx, Delete, Get, Head, Header, Headers, HttpCode, Options, Param, Patch, Post, Put,
  Query, Req, Res, UseGuard, UseInterceptor, Validate, createRouteDecorator,
} from '@znight/http'
import { Injectable } from '@znight/core'
import { z } from 'zod'
`

/** Analyses `src/app.ts` (after the shared imports) and returns the extension's diagnostics. */
async function diagnose(source: string, options: { strictValidation?: boolean } = {}): Promise<string[]> {
  const app = tempApp({ 'src/app.ts': `${IMPORTS}${source}` })
  return httpDiagnostics(await analyzeApp(app.root, options))
}

/** Line of `src/app.ts` for a source line (the shared imports take 6 lines). */
const L = (line: number): number => line + 6

describe('ZNIGHT005: decorator usage', () => {
  it('HTTP decorators outside of a controller', async () => {
    expect(
      await diagnose(`
export class BaseController {
  @Get('/a')
  @HttpCode(201)
  list(@Query('page') page: number) { return page }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(3)}:3 @Get has no effect: BaseController is not a controller`,
      `error ZNIGHT005 src/app.ts:${L(4)}:3 @HttpCode has no effect: BaseController is not a controller`,
      `error ZNIGHT005 src/app.ts:${L(5)}:8 @Query has no effect: BaseController is not a controller`,
    ])
  })

  it('decorators on targets they do not support (core) and on methods that are not routes', async () => {
    expect(
      await diagnose(`
export const Tag = createRouteDecorator<string>('tag')
@Controller('/x')
@Get()
export class XController {
  constructor(@Param('id') readonly id: string) {}
  @HttpCode(201)
  @Tag('helper')
  helper(@Query('q') q: string) { return q }
  @Controller()
  route() { return 1 }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(4)}:1 @Get cannot be applied to a class (allowed on a method)`,
      `error ZNIGHT005 src/app.ts:${L(6)}:15 @Param cannot be applied to a constructor parameter (allowed on a method parameter)`,
      `error ZNIGHT005 src/app.ts:${L(7)}:3 @HttpCode has no effect: XController.helper is not a route`,
      `warning ZNIGHT005 src/app.ts:${L(8)}:3 @Tag has no effect: XController.helper is not a route`,
      `error ZNIGHT005 src/app.ts:${L(9)}:10 @Query has no effect: XController.helper is not a route`,
      `error ZNIGHT005 src/app.ts:${L(10)}:3 @Controller cannot be applied to a method (allowed on a class)`,
    ])
  })

  it('controller options', async () => {
    expect(
      await diagnose(`
@Controller(42)
export class A {}
@Controller({ path: 1, scope: 'session', prefix: '/x' })
export class B {}
@Controller('/c')
@Controller('/d')
export class C {}
declare function makePath(): string
@Controller(makePath())
export class D {}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(2)}:13 @Controller expects a path or { path?, scope? }, got 42`,
      `error ZNIGHT005 src/app.ts:${L(4)}:13 @Controller: "path" must be a string, got 1`,
      `error ZNIGHT005 src/app.ts:${L(4)}:13 @Controller: invalid scope "session"`,
      `error ZNIGHT005 src/app.ts:${L(4)}:13 @Controller: unknown option "prefix"`,
      `error ZNIGHT005 src/app.ts:${L(7)}:1 @Controller is applied several times to C`,
      `error ZNIGHT005 src/app.ts:${L(10)}:13 Invalid argument 1 of @Controller: it must be statically evaluable (A function call is not statically evaluable)`,
    ])
  })

  it('handlers must be public instance methods with a plain name', async () => {
    expect(
      await diagnose(`
const KEY = 'computed'
@Controller('/h')
export class H {
  @Get('/a') static a() {}
  @Get('/b') #b() {}
  @Get('/c') private c() {}
  @Get('/d') protected d() {}
  @Get('/e') get e() { return 1 }
  @Get('/f') [KEY]() {}
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(5)}:3 Static method H.a cannot be a route handler`,
      `error ZNIGHT005 src/app.ts:${L(6)}:3 #private method H.#b cannot be a route handler`,
      `error ZNIGHT005 src/app.ts:${L(7)}:3 Private method H.c cannot be a route handler`,
      `error ZNIGHT005 src/app.ts:${L(8)}:3 Protected method H.d cannot be a route handler`,
      `error ZNIGHT005 src/app.ts:${L(9)}:3 Accessor H.e cannot be a route handler`,
      `error ZNIGHT005 src/app.ts:${L(10)}:3 H.[KEY] cannot be a route handler: handlers need a plain name (no computed key)`,
    ])
  })

  it('handler parameters', async () => {
    expect(
      await diagnose(`
export const Schema = z.object({ a: z.string() })
export class NotASchema {}
@Controller('/p')
export class P {
  @Get('/:id')
  a(@Param('id') id: string, plain: string) { return [id, plain] }
  @Get('/b/:id')
  b(@Param('id') @Query('id') id: string) { return id }
  @Get('/c')
  c(@Query('q') ...rest: string[]) { return rest }
  @Get('/d/:id')
  d(@Param(42) id: string, @Param(Schema, 'x') s: unknown, @Query('q', 'x') q: string) { return [id, s, q] }
  @Post('/e')
  e(@Body('x') body: unknown, @Headers('bad header') h: string) { return [body, h] }
  @Post('/f')
  f(@Body(NotASchema) body: unknown) { return body }
  @Post('/g')
  g(@Body(z.object({})) body: unknown) { return body }
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(7)}:30 Parameter 'plain' of P.a has no HTTP decorator`,
      `error ZNIGHT005 src/app.ts:${L(9)}:18 Parameter 'id' of P.b has several HTTP decorators`,
      `error ZNIGHT005 src/app.ts:${L(11)}:5 Rest parameter 'rest' of P.c cannot be injected`,
      `error ZNIGHT005 src/app.ts:${L(13)}:12 @Param expects a name (non-empty string) or a schema, got 42`,
      `error ZNIGHT005 src/app.ts:${L(13)}:43 @Param(schema) takes a single argument`,
      `error ZNIGHT005 src/app.ts:${L(13)}:72 @Query expects a Standard Schema, got "x"`,
      `error ZNIGHT005 src/app.ts:${L(15)}:11 @Body expects a Standard Schema, got "x"`,
      `error ZNIGHT005 src/app.ts:${L(15)}:40 @Headers: invalid header name "bad header"`,
      `warning ZNIGHT005 src/app.ts:${L(17)}:11 @Body(NotASchema): NotASchema is a class, not a Standard Schema; the validation fails at runtime`,
      `error ZNIGHT005 src/app.ts:${L(19)}:11 Invalid argument 1 of @Body: A function call is not statically evaluable`,
    ])
  })

  it('@Validate', async () => {
    expect(
      await diagnose(`
export const A = z.object({ a: z.string() })
export const B = z.object({ b: z.string() })
@Controller('/v')
export class V {
  @Post('/a') @Validate(A) a(@Body(B) body: unknown) { return body }
  @Post('/b') @Validate(A) @Validate(B) b() {}
  @Post('/c') @Validate() c() {}
  @Post('/d') @Validate('x') d() {}
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(6)}:15 The body of V.a is validated twice: @Validate(A) and @Body(B)`,
      `error ZNIGHT005 src/app.ts:${L(7)}:28 @Validate is applied several times`,
      `error ZNIGHT005 src/app.ts:${L(8)}:15 @Validate requires a schema`,
      `error ZNIGHT005 src/app.ts:${L(9)}:25 @Validate expects a Standard Schema, got "x"`,
    ])
  })

  it('@HttpCode and @Header', async () => {
    expect(
      await diagnose(`
@Controller('/s')
export class S {
  @Get('/a') @HttpCode(42) a() {}
  @Get('/b') @HttpCode('201') b() {}
  @Get('/c') @HttpCode(201) @HttpCode(202) c() {}
  @Get('/d') @HttpCode() d() {}
  @Get('/e') @Header('bad name', 'x') @Header('x-a', 1) @Header('x-b') e() {}
  @Get('/f') @Header('X-Dup', 'a') @Header('x-dup', 'b') f() {}
  @Get('/g') @Header('x-crlf', 'a\\r\\nb') g() {}
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(4)}:24 @HttpCode expects an integer status between 100 and 599, got 42`,
      `error ZNIGHT005 src/app.ts:${L(5)}:24 @HttpCode expects an integer status between 100 and 599, got "201"`,
      `error ZNIGHT005 src/app.ts:${L(6)}:29 @HttpCode is applied several times`,
      `error ZNIGHT005 src/app.ts:${L(7)}:14 @HttpCode requires a status`,
      `error ZNIGHT005 src/app.ts:${L(8)}:22 @Header: invalid header name "bad name"`,
      `error ZNIGHT005 src/app.ts:${L(8)}:54 @Header: the value of "x-a" must be a string without line breaks`,
      `error ZNIGHT005 src/app.ts:${L(8)}:57 @Header requires a name and a value`,
      `error ZNIGHT005 src/app.ts:${L(9)}:36 @Header: "x-dup" is set several times`,
      `error ZNIGHT005 src/app.ts:${L(10)}:32 @Header: the value of "x-crlf" must be a string without line breaks`,
    ])
  })

  it('@UseGuard / @UseInterceptor arguments', async () => {
    expect(
      await diagnose(`
export function notAClass(): boolean { return true }
@Controller('/g')
@UseGuard()
export class G {
  @Get('/a') @UseGuard(notAClass) a() {}
  @Get('/b') @UseInterceptor('x') b() {}
}
`),
    ).toEqual([
      `error ZNIGHT005 src/app.ts:${L(4)}:1 @UseGuard requires at least one guard`,
      `error ZNIGHT005 src/app.ts:${L(6)}:24 'notAClass' is not a class: the guard must be a class`,
      `error ZNIGHT005 src/app.ts:${L(7)}:30 expected a reference to the interceptor class, got 'x'`,
    ])
  })

  it('@Res() is an adapter-specific escape hatch (warning)', async () => {
    expect(
      await diagnose(`
@Controller('/r')
export class R {
  @Get() raw(@Req() req: unknown, @Res() res: unknown) { return [req, res] }
}
`),
    ).toEqual([
      `warning ZNIGHT005 src/app.ts:${L(4)}:35 @Res() makes R.raw adapter-specific: the handler writes the native response itself`,
    ])
  })
})

describe('ZNIGHT005: route decorators (createRouteDecorator)', () => {
  it('invalid usages', async () => {
    const app = tempApp({
      'src/decorators.ts': `
import { createRouteDecorator } from '@znight/http'
declare const dynamicKey: string
export const Roles = createRouteDecorator<readonly string[]>('roles')
export const Also = createRouteDecorator<readonly string[]>('roles')
export const Public = createRouteDecorator('public')
export const Broken = createRouteDecorator(dynamicKey)
export const NoKey = (createRouteDecorator as (key?: string) => never)()
`,
      'src/app.ts': `
import { Controller, Get } from '@znight/http'
import { Also, Broken, NoKey, Public, Roles } from './decorators.ts'
class Hidden {}
declare function compute(): string[]
@Controller('/m')
@Roles(['a'])
@Also(['b'])
export class M {
  @Get('/a') @Public a() {}
  @Get('/b') @Roles(['a'], ['b']) b() {}
  @Get('/c') @Roles(compute()) c() {}
  @Get('/d') @Roles([Hidden]) d() {}
  @Get('/e') @Broken() e() {}
  @Get('/f') @NoKey() f() {}
}
`,
    })
    expect(httpDiagnostics(await analyzeApp(app.root))).toEqual([
      "error ZNIGHT005 src/app.ts:8:1 @Also sets the route metadata 'roles', already set on the same target",
      'error ZNIGHT005 src/app.ts:10:14 @Public must be called: @Public()',
      'error ZNIGHT005 src/app.ts:11:14 @Roles takes at most one argument',
      'error ZNIGHT005 src/app.ts:12:21 Invalid argument of @Roles: A function call is not statically evaluable',
      "error ZNIGHT005 src/app.ts:13:22 Invalid argument of @Roles: 'Hidden' cannot be imported by the generated module ('Hidden' is not exported by src/app.ts)",
      'error ZNIGHT005 src/app.ts:14:14 Invalid route decorator @Broken: the key of the route decorator Broken must be a statically evaluable non-empty string',
      'error ZNIGHT005 src/app.ts:15:14 Invalid route decorator @NoKey: createRouteDecorator() requires a key (NoKey)',
    ])
  })
})

describe('ZNIGHT007: routes', () => {
  it('path grammar (route and base paths)', async () => {
    expect(
      await diagnose(`
@Controller('/a b')
export class A {
  @Get() a() {}
}
@Controller('/b/:id')
export class B {
  @Get('/x//y') a() {}
  @Get('/:id-x') b() {}
  @Get('/*/x') c() {}
  @Get('/x?y=1') d() {}
  @Get('/:id') e(@Param('id') id: string) { return id }
  @Get('/z') f(@Param('id') id: string) { return id }
}
`),
    ).toEqual([
      `error ZNIGHT007 src/app.ts:${L(2)}:13 Invalid base path "/a b" of A: invalid character " " in "a b" (allowed: letters, digits and - . _ ~ ! $ & ' + , ; = @)`,
      `error ZNIGHT007 src/app.ts:${L(8)}:8 Invalid route path "/x//y" of B.a: empty segment ("//")`,
      `error ZNIGHT007 src/app.ts:${L(9)}:8 Invalid route path "/:id-x" of B.b: invalid parameter name "id-x" (expected letters, digits and "_", not starting with a digit)`,
      `error ZNIGHT007 src/app.ts:${L(10)}:8 Invalid route path "/*/x" of B.c: the wildcard "*" must be the last segment`,
      `error ZNIGHT007 src/app.ts:${L(11)}:8 Invalid route path "/x?y=1" of B.d: a route path cannot contain "?" or "#" (query strings are not part of routes)`,
      // base path '/b/:id' + route path '/:id'
      `error ZNIGHT007 src/app.ts:${L(12)}:8 Invalid route path "/b/:id/:id" of B.e: duplicate parameter ":id"`,
    ])
  })

  it('route parameters and @Param', async () => {
    expect(
      await diagnose(`
@Controller('/p')
export class P {
  @Get('/:id') a() {}
  @Get('/b/:id') b(@Param('other') other: string) { return other }
  @Get('/c/:id') c(@Param() all: Record<string, string>) { return all }
  @Get('/d/:id') d(@Ctx() ctx: unknown) { return ctx }
  @Get('/e/*') e(@Param('*') rest: string) { return rest }
  @Get('/f/*') f() {}
  @Get('/g') g(@Param('*') rest: string) { return rest }
}
`),
    ).toEqual([
      `error ZNIGHT007 src/app.ts:${L(4)}:8 Route GET /p/:id declares ":id" but P.a has no @Param('id') parameter`,
      `error ZNIGHT007 src/app.ts:${L(5)}:8 Route GET /p/b/:id declares ":id" but P.b has no @Param('id') parameter`,
      `error ZNIGHT007 src/app.ts:${L(5)}:20 @Param('other') of P.b: the route GET /p/b/:id has no ":other" parameter`,
      // c (@Param()), d (@Ctx()) and e/f (wildcards need no @Param) are valid
      `error ZNIGHT007 src/app.ts:${L(10)}:16 @Param('*') of P.g: the route GET /p/g has no wildcard`,
    ])
  })

  it('duplicate routes across controllers', async () => {
    expect(
      await diagnose(`
@Controller('/users')
export class A {
  @Get('/:id') a(@Param('id') id: string) { return id }
  @All('/any') any() {}
  @Get('/head') head() {}
}
@Controller('/users')
export class B {
  @Get('/:userId') b(@Param('userId') id: string) { return id }
  @Post('/:id') c(@Param('id') id: string) { return id }
  @All('/any') any() {}
  @Get('/any') getAny() {}
  @Head('/head') head() {}
}
`),
    ).toEqual([
      // same method and shape (parameter names aside); POST, GET vs ALL and HEAD vs GET do not conflict
      `error ZNIGHT007 src/app.ts:${L(10)}:3 Duplicate route GET /users/:userId: B.b conflicts with A.a (GET /users/:id)`,
      `error ZNIGHT007 src/app.ts:${L(12)}:3 Duplicate route ALL /users/any: B.any conflicts with A.any (ALL /users/any)`,
    ])
  })

  it('types that cannot be coerced', async () => {
    expect(
      await diagnose(`
interface Filter { readonly a: string }
@Controller('/t')
export class T {
  @Get('/a/:id') a(@Param('id') id: Filter) { return id }
  @Get('/b/:id') b(@Param('id') id: string | number) { return id }
  @Get('/c/:id') c(@Param('id') id: [string, string]) { return id }
  @Get('/d/:id') d(@Param('id') id: string[][]) { return id }
  @Get('/e/:id') e(@Param('id') id) { return id }
  @Get('/f') f(@Headers('x-a') a: symbol, @Headers('x-b') b: 10n) { return [a, b] }
  @Get('/g/:id') g(@Param('id') id = []) { return id }
}
`),
    ).toEqual([
      `error ZNIGHT007 src/app.ts:${L(5)}:37 Invalid param "id" of T.a: type 'Filter' cannot be coerced (objects cannot be read from a single request value)`,
      `error ZNIGHT007 src/app.ts:${L(6)}:37 Invalid param "id" of T.b: type 'number | string' cannot be coerced (only unions of literal types can be coerced)`,
      `error ZNIGHT007 src/app.ts:${L(7)}:37 Invalid param "id" of T.c: type '[string, string]' cannot be coerced (this type cannot be read from a request value)`,
      `error ZNIGHT007 src/app.ts:${L(8)}:37 Invalid param "id" of T.d: type 'string[][]' cannot be coerced (nested arrays cannot be coerced)`,
      `error ZNIGHT007 src/app.ts:${L(9)}:33 Invalid param "id" of T.e: the type of parameter 'id' is unknown`,
      `error ZNIGHT007 src/app.ts:${L(10)}:35 Invalid header "x-a" of T.f: type 'symbol' cannot be coerced ('symbol' values cannot be read from a request)`,
      `error ZNIGHT007 src/app.ts:${L(10)}:62 Invalid header "x-b" of T.f: type '10n' cannot be coerced (bigint literal types are not supported)`,
      // an empty array default tells nothing about the element type
      `error ZNIGHT007 src/app.ts:${L(11)}:20 Invalid param "id" of T.g: the type of parameter 'id' is unknown`,
    ])
  })
})

describe('ZNIGHT017: unvalidated input', () => {
  const source = `
interface CreateUser { readonly name: string }
interface Filter { readonly a: string }
@Controller('/u')
export class U {
  @Post('/a') a(@Body() body: CreateUser) { return body }
  @Get('/b') b(@Query() query: Filter) { return query }
  @Get('/c') c(@Query('filter') filter: Filter) { return filter }
  @Get('/d') d(@Query('x') x: any, @Query('y') y) { return [x, y] }
  @Post('/e') e(@Body() body: any) { return body }
  @Post('/ok') ok(
    @Body() text: string,
    @Query() query: Record<string, string | string[]>,
    @Query('raw') raw: unknown,
  ) { return [text, query, raw] }
  @Post('/bytes') bytes(@Body() bytes: Uint8Array) { return bytes }
  @Post('/unknown') unknown(@Body() body: unknown) { return body }
}
`

  it('warnings by default', async () => {
    expect(await diagnose(source)).toEqual([
      `warning ZNIGHT017 src/app.ts:${L(6)}:17 Unvalidated input: the body of U.a ('body', typed CreateUser) has no schema`,
      `warning ZNIGHT017 src/app.ts:${L(7)}:16 Unvalidated input: the query of U.b ('query', typed Filter) has no schema`,
      `warning ZNIGHT017 src/app.ts:${L(8)}:16 Unvalidated input: query "filter" of U.c: type 'Filter' cannot be coerced (objects cannot be read from a single request value)`,
      `warning ZNIGHT017 src/app.ts:${L(9)}:16 Unvalidated input: query "x" of U.d is typed any`,
      `warning ZNIGHT017 src/app.ts:${L(9)}:36 Unvalidated input: query "y" of U.d: the type of parameter 'y' is unknown`,
      `warning ZNIGHT017 src/app.ts:${L(10)}:17 Unvalidated input: the body of U.e ('body', typed any) has no schema`,
      // strings, Record<string, string | string[]>, unknown and Uint8Array need no schema
    ])
  })

  it('errors with strictValidation', async () => {
    const lines = await diagnose(source, { strictValidation: true })
    expect(lines.every(line => line.startsWith('error ZNIGHT017'))).toBe(true)
    expect(lines).toHaveLength(6)
  })
})

describe('ZNIGHT003: guards and interceptors', () => {
  it('a singleton controller cannot use a request-scoped guard; a request-scoped one can', async () => {
    const app = tempApp({
      'src/app.ts': `
import { Injectable } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'
import { Controller, Get, UseGuard } from '@znight/http'
@Injectable({ scope: 'request' })
export class RequestGuard implements CanActivate {
  constructor(private readonly ctx: HttpContext) {}
  canActivate(): boolean { return this.ctx.method === 'GET' }
}
@Controller('/a')
export class SingletonController {
  @Get() @UseGuard(RequestGuard) a() {}
}
@Controller({ path: '/b', scope: 'request' })
@UseGuard(RequestGuard)
export class ScopedController {
  @Get() b() {}
}
`,
    })
    // the plugin resolves request-scoped guards per request, but the controller -> guard edge follows
    // the spec (§4.8: "a singleton depends ... through guards ... on a request-scoped provider")
    expect(render(await analyzeApp(app.root))).toEqual([
      'error ZNIGHT003 src/app.ts:12:20 Scope mismatch: singleton SingletonController depends on request-scoped RequestGuard (SingletonController -> RequestGuard)',
    ])
  })
})

describe('ZNIGHT005: decorators of another package', () => {
  /** An application where `@znight/messaging` (which has `Headers` and `Ctx` too) is installed. */
  async function withMessaging(source: string): Promise<{ lines: string[]; diagnostics: readonly Diagnostic[] }> {
    const app = tempApp({ 'src/a.ts': source })
    fs.symlinkSync(
      path.resolve(HTTP_ROOT, '../messaging'),
      path.join(app.root, 'node_modules/@znight/messaging'),
      'dir',
    )
    const result = await analyzeApp(app.root, { discover: true })
    return { lines: render(result), diagnostics: result.diagnostics }
  }

  it('leaves the parameters of a consumer handler to @znight/messaging, without suggesting @Controller()', async () => {
    const { lines, diagnostics } = await withMessaging(`import { Consumer, Message, OnMessage } from '@znight/messaging'
import { Body, Get, Headers, UseGuard } from '@znight/http'

export class AllowAll { canActivate() { return true } }

@Consumer('orders')
@UseGuard(AllowAll)
export class OrderConsumer {
  @OnMessage()
  handle(@Headers('x-a') a: string, @Message() @Body() payload: unknown, @Body() extra?: unknown) { return [a, payload, extra] }
  @Get('/x') other(@Headers('x-b') b: string) { return b }
}
`)
    const http = lines.filter(line => !line.includes("'@znight/http': @OnMessage handler parameters"))
    expect(http).toEqual([
      'error ZNIGHT005 src/a.ts:7:1 @UseGuard has no effect: OrderConsumer is not a controller',
      "error ZNIGHT005 src/a.ts:10:48 @Body has no effect on parameter 'payload' of OrderConsumer.handle: it is an @OnMessage handler of '@znight/messaging'",
      "error ZNIGHT005 src/a.ts:10:74 @Body has no effect on parameter 'extra' of OrderConsumer.handle: it is an @OnMessage handler of '@znight/messaging'",
      'error ZNIGHT005 src/a.ts:11:3 @Get has no effect: OrderConsumer is not a controller',
      'error ZNIGHT005 src/a.ts:11:20 @Headers has no effect: OrderConsumer is not a controller',
    ])
    // the misplaced `Headers` of the handler is reported once, by @znight/messaging
    expect(lines.filter(line => line.includes('src/a.ts:10:10 '))).toEqual([
      "error ZNIGHT005 src/a.ts:10:10 @Headers on parameter 'a' of OrderConsumer.handle() is imported from '@znight/http': @OnMessage handler parameters use Headers from '@znight/messaging'",
    ])
    const hints = diagnostics.flatMap(diagnostic => diagnostic.hints ?? [])
    expect(hints.filter(hint => hint.includes('Add @Controller()'))).toEqual([])
    expect(hints).toContain(
      "OrderConsumer is a @Consumer class of '@znight/messaging': HTTP decorators only apply to @Controller() classes",
    )
  })

  it('names the package of a route parameter decorator imported from @znight/messaging', async () => {
    const { lines, diagnostics } = await withMessaging(`import { Ctx, Headers } from '@znight/messaging'
import { Controller, Get } from '@znight/http'

@Controller('/users')
export class UserController {
  @Get('/') list(@Ctx() context: unknown, @Headers('x-a') a: string) { return [context, a] }
}
`)
    const http = lines.filter(line => line.includes('route parameters') || line.includes('no HTTP decorator'))
    expect(http).toEqual([
      "error ZNIGHT005 src/a.ts:6:18 @Ctx on parameter 'context' of UserController.list is imported from '@znight/messaging': route parameters use Ctx from '@znight/http'",
      "error ZNIGHT005 src/a.ts:6:43 @Headers on parameter 'a' of UserController.list is imported from '@znight/messaging': route parameters use Headers from '@znight/http'",
    ])
    expect(diagnostics.flatMap(diagnostic => diagnostic.hints ?? [])).toContain(
      "Import it from '@znight/http': import { Ctx } from '@znight/http'",
    )
  })

  it('names the module of a look-alike decorator, without @znight/messaging', async () => {
    const app = tempApp({
      'src/decorators.ts': 'export function Body(): ParameterDecorator { return () => undefined }\n',
      'src/app.ts': `import { Controller, Post } from '@znight/http'
import { Body } from './decorators.ts'
@Controller('/users')
export class UserController {
  @Post('/') create(@Body() body: unknown) { return body }
}
`,
    })
    expect(httpDiagnostics(await analyzeApp(app.root))).toEqual([
      "error ZNIGHT005 src/app.ts:5:21 @Body on parameter 'body' of UserController.create is imported from 'src/decorators.ts': route parameters use Body from '@znight/http'",
    ])
  })
})
