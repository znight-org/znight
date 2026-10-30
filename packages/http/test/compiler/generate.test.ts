/**
 * `generate()`: the `metadata.extensions.http` section built with the GenerateContext builders
 * (structure of the nodes, imports requested, printed form).
 */
import type { GenNode } from '@znight/compiler'
import type { GeneratedSection } from './helpers.ts'

import { analyzeApp, cleanupApps, fixtureApp, generateSection, print, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

let section: GeneratedSection

beforeAll(async () => {
  section = generateSection(await analyzeApp(fixtureApp('app').root))
})

afterAll(cleanupApps)

/** The entries of an object node. */
function entries(node: GenNode | undefined): Map<string, GenNode> {
  if (node?.kind !== 'gen:object') {
    throw new Error(`expected an object node, got ${node?.kind}`)
  }
  return new Map(node.entries)
}

function items(node: GenNode | undefined): readonly GenNode[] {
  if (node?.kind !== 'gen:array') {
    throw new Error(`expected an array node, got ${node?.kind}`)
  }
  return node.items
}

/** The object nodes of the controllers of the fixture section. */
function controllers(): Map<string, GenNode>[] {
  return items(entries(section.node).get('controllers')).map(entries)
}

/** The object node of a route of the fixture section. */
function routeOf(controller: string, handler: string): Map<string, GenNode> {
  const found = controllers().find(fields => literalOf(fields.get('token')).endsWith(`#${controller}`))
  const route = items(found?.get('routes'))
    .map(entries)
    .find(fields => literalOf(fields.get('handler')) === handler)
  if (!route) {
    throw new Error(`no route ${controller}.${handler}`)
  }
  return route
}

function literalOf(node: GenNode | undefined): string {
  return node?.kind === 'gen:literal' ? String(node.value) : ''
}

/** `code` without the indentation of its lines (compares blocks wherever they are nested). */
function unindent(code: string): string {
  return code.replace(/\n[ ]+/g, '\n')
}

/** Printed `invoke` of a route of the fixture section. */
function invoke(controller: string, handler: string): string {
  return print(routeOf(controller, handler).get('invoke') as GenNode)
}

describe('section of the fixture application', () => {
  it('imports only what the generated code uses', () => {
    expect(section.imports).toEqual([
      'coerce from @znight/http',
      'isThenable from @znight/http',
      'type HttpContext from @znight/http',
      'type src/health.controller.ts#HealthController',
      'type src/root.controller.ts#RootController',
      'type src/users/user.controller.ts#UserController',
      'validate from @znight/http',
    ])
    expect(section.diagnostics).toEqual([])
  })

  it('is { controllers: [...] } sorted by token with the documented keys', () => {
    expect([...entries(section.node).keys()]).toEqual(['controllers'])
    expect(controllers().map(controller => literalOf(controller.get('token')))).toEqual([
      'src/health.controller.ts#HealthController',
      'src/root.controller.ts#RootController',
      'src/users/user.controller.ts#UserController',
    ])
    expect([...(controllers()[0] as Map<string, GenNode>).keys()]).toEqual([
      'token',
      'basePath',
      'guards',
      'interceptors',
      'meta',
      'routes',
    ])
  })

  it('omits optional route and parameter fields when absent', () => {
    expect([...routeOf('UserController', 'list').keys()]).toEqual([
      'method',
      'path',
      'fullPath',
      'handler',
      'meta',
      'guards',
      'interceptors',
      'params',
      'invoke',
    ])
    expect([...routeOf('UserController', 'remove').keys()]).toEqual([
      'method',
      'path',
      'fullPath',
      'handler',
      'status',
      'headers',
      'meta',
      'guards',
      'interceptors',
      'params',
      'invoke',
    ])
    expect([...routeOf('RootController', 'raw').keys()]).toEqual([
      'method',
      'path',
      'fullPath',
      'handler',
      'meta',
      'guards',
      'interceptors',
      'params',
      'rawResponse',
      'invoke',
    ])
    const params = (handler: string): string[][] =>
      items(routeOf('UserController', handler).get('params')).map(param => [...entries(param).keys()])
    expect(params('find')).toEqual([['index', 'source', 'name', 'type']])
    expect(params('search')).toEqual([['index', 'source', 'schema']])
    expect(params('list')[0]).toEqual(['index', 'source', 'name', 'type', 'optional'])
    expect(params('options')).toEqual([['index', 'source']])
  })

  it('types the invoke parameters with the controller class and HttpContext', () => {
    expect(routeOf('UserController', 'find').get('invoke')).toMatchObject({
      kind: 'gen:arrow',
      async: false,
      params: [
        {
          name: 'c',
          type: {
            kind: 'gen:import',
            typeOnly: true,
            target: { kind: 'identity', identity: 'src/users/user.controller.ts#UserController' },
          },
        },
        {
          name: 'ctx',
          type: {
            kind: 'gen:import',
            typeOnly: true,
            target: { kind: 'module', module: '@znight/http', name: 'HttpContext' },
          },
        },
      ],
      body: { kind: 'gen:call', callee: { kind: 'gen:member', property: 'find' } },
    })
  })

  it('generates invoke functions as documented', () => {
    expect(invoke('RootController', 'index')).toBe('(c: RootController) => c.index()')
    expect(invoke('RootController', 'raw')).toBe(
      '(c: RootController, ctx: HttpContext) => c.raw(ctx.request as never, ctx.response as never)',
    )
    expect(invoke('UserController', 'find')).toBe(
      `(c: UserController, ctx: HttpContext) => c.find(coerce.number(ctx.params['id'], 'param "id"'))`,
    )
    expect(invoke('UserController', 'list')).toBe(
      "(c: UserController, ctx: HttpContext) => c.list(coerce.optional(ctx.query['page'], 'query \"page\"', coerce.number), " +
        "coerce.optional(ctx.query['tag'], 'query \"tag\"', (v, l) => coerce.array(v, l, coerce.string)), " +
        "coerce.optional(ctx.query['sort'], 'query \"sort\"', (v, l) => coerce.enum(v, l, ['asc', 'desc'])))",
    )
    // synchronous while validate() returns values; the rest awaited in an async arrow otherwise
    expect(invoke('UserController', 'search')).toBe(
      [
        '(c: UserController, ctx: HttpContext) => {',
        "  const a0 = validate(SearchQuery, ctx.query, 'query')",
        '  if (isThenable(a0)) return (async () => c.search(await a0))()',
        '  return c.search(a0)',
        '}',
      ].join('\n'),
    )
    expect(invoke('UserController', 'create')).toBe(
      [
        '(c: UserController, ctx: HttpContext) => {',
        "  const a0 = validate(CreateUser, ctx.body, 'body')",
        '  if (isThenable(a0)) return (async () => c.create(await a0))()',
        '  return c.create(a0)',
        '}',
      ].join('\n'),
    )
    expect(invoke('UserController', 'update')).toBe(
      [
        '(c: UserController, ctx: HttpContext) => {',
        `  const a0 = validate(IdParam, ctx.params['id'], 'param "id"')`,
        "  if (isThenable(a0)) return (async () => c.update(await a0, await validate(UpdateUser, ctx.body, 'body')))()",
        "  const a1 = validate(UpdateUser, ctx.body, 'body')",
        '  if (isThenable(a1)) return (async () => c.update(a0, await a1))()',
        '  return c.update(a0, a1)',
        '}',
      ].join('\n'),
    )
    expect(invoke('UserController', 'flags')).toBe(
      `(c: UserController, ctx: HttpContext) => c.flags(ctx.params as never, coerce.boolean(ctx.headers['x-flag'], 'header "x-flag"'), ctx.headers as never)`,
    )
    expect(invoke('UserController', 'options')).toBe('(c: UserController, ctx: HttpContext) => c.options(ctx)')
    expect(invoke('UserController', 'legacy')).toBe(
      `(c: UserController, ctx: HttpContext) => c.legacy(coerce.string(ctx.params['*'], 'param "*"'), ctx)`,
    )
    expect(invoke('UserController', 'ping')).toBe(
      "async (c: UserController, ctx: HttpContext) => { await validate(Ping, await ctx.parseBody(), 'body'); return c.ping() }",
    )
    expect(invoke('UserController', 'typed')).toBe(
      "(c: UserController, ctx: HttpContext) => c.typed(coerce.date(ctx.params['day'], 'param \"day\"'), " +
        "coerce.optional(ctx.query['flag'], 'query \"flag\"', coerce.boolean), " +
        "coerce.optional(ctx.query['big'], 'query \"big\"', coerce.bigint), " +
        "coerce.optional(ctx.query['ids'], 'query \"ids\"', (v, l) => coerce.array(v, l, coerce.string)) as never, " +
        "coerce.optional(ctx.query['color'], 'query \"color\"', (v, l) => coerce.enum(v, l, ['red', 'blue'])) as never, " +
        "coerce.optional(ctx.headers['x-id'], 'header \"x-id\"', coerce.string) as never)",
    )
    expect(invoke('HealthController', 'check')).toBe(
      `(c: HealthController, ctx: HttpContext) => c.check(coerce.optional(ctx.headers['x-request-id'], 'header "x-request-id"', coerce.string) as never)`,
    )
  })

  it('prints the whole section', () => {
    expect(section.code).toMatchSnapshot()
  })
})

describe('generation edge cases', () => {
  it('returns undefined without controllers (no import)', async () => {
    const app = tempApp({
      'src/service.ts': `
import { Injectable } from '@znight/core'
import type { HttpContext } from '@znight/http'
@Injectable({ scope: 'request' })
export class CurrentRequest {
  constructor(readonly ctx: HttpContext) {}
}
`,
    })
    const generated = generateSection(await analyzeApp(app.root))
    expect(generated.node).toBeUndefined()
    expect(generated.imports).toEqual([])
  })

  it('does not import coerce / validate when unused', async () => {
    const app = tempApp({
      'src/ping.controller.ts': `
import { Controller, Get, Ctx } from '@znight/http'
import type { HttpContext } from '@znight/http'
@Controller('/ping')
export class PingController {
  @Get() ping(@Ctx() ctx: HttpContext) { return ctx.path }
}
`,
    })
    const generated = generateSection(await analyzeApp(app.root))
    expect(generated.imports).toEqual([
      'type HttpContext from @znight/http',
      'type src/ping.controller.ts#PingController',
    ])
  })

  it('emits route metadata values, including references to exported bindings', async () => {
    const app = tempApp({
      'src/policies.ts': `
import { createRouteDecorator } from '@znight/http'
export class AdminPolicy {}
export const Policy = createRouteDecorator<unknown>('policy')
export const Limits = createRouteDecorator<{ readonly max: number; readonly policy: unknown }>('limits')
export const MAX = 10
`,
      'src/admin.controller.ts': `
import { Controller, Get } from '@znight/http'
import { AdminPolicy, Limits, MAX, Policy } from './policies.ts'
@Controller('/admin')
@Policy(AdminPolicy)
export class AdminController {
  @Get()
  @Limits({ max: MAX * 2, policy: AdminPolicy })
  index() { return 'ok' }
}
`,
    })
    const generated = generateSection(await analyzeApp(app.root))
    expect(generated.code).toContain('meta: {\n        policy: AdminPolicy,\n      },')
    expect(generated.code).toContain('limits: { max: 20, policy: AdminPolicy },')
    const controller = entries(items(entries(generated.node).get('controllers'))[0])
    expect(entries(controller.get('meta')).get('policy')).toMatchObject({
      kind: 'gen:literal',
      value: { kind: 'ref', identity: 'src/policies.ts#AdminPolicy' },
    })
  })

  it('validates whole objects and named values with schemas, passes unvalidated values as is', async () => {
    const app = tempApp({
      'src/schemas.ts': `
import { z } from 'zod'
export const Params = z.object({ id: z.string() })
export const Page = z.coerce.number().int()
`,
      'src/items.controller.ts': `
import { Body, Controller, Headers, Param, Post, Query } from '@znight/http'
import { Page, Params } from './schemas.ts'
@Controller('/items')
export class ItemsController {
  @Post('/:id')
  create(
    @Param(Params) params: { id: string },
    @Query('page', Page) page: number,
    @Body() text: string,
    @Headers() headers: Record<string, string | undefined>,
    @Query() query: unknown,
  ) { return [params, page, text, headers, query] }
}
`,
    })
    const generated = generateSection(await analyzeApp(app.root))
    expect(generated.diagnostics).toEqual([])
    const rest = 'ctx.body as never, ctx.headers as never, ctx.query as never'
    expect(unindent(generated.code)).toContain(
      [
        'invoke: (c: ItemsController, ctx: HttpContext) => {',
        "const a0 = validate(Params, ctx.params, 'params')",
        `if (isThenable(a0)) return (async () => c.create(await a0, await validate(Page, ctx.query['page'], 'query "page"'), ${rest}))()`,
        `const a1 = validate(Page, ctx.query['page'], 'query "page"')`,
        `if (isThenable(a1)) return (async () => c.create(a0, await a1, ${rest}))()`,
        `return c.create(a0, a1, ${rest})`,
        '},',
      ].join('\n'),
    )
    expect(generated.imports).toContain('validate from @znight/http')
    expect(generated.imports).toContain('isThenable from @znight/http')
    expect(generated.imports).not.toContain('coerce from @znight/http')
  })

  it('evaluates the arguments up to the last validated one in order, inlining @Ctx() and the later ones', async () => {
    const app = tempApp({
      'src/schemas.ts': `
import { z } from 'zod'
export const Order = z.object({ total: z.number() })
`,
      'src/orders.controller.ts': `
import type { HttpContext } from '@znight/http'
import { Body, Controller, Ctx, Put, Query, Param } from '@znight/http'
import { Order } from './schemas.ts'
@Controller('/orders')
export class OrdersController {
  @Put('/:id')
  update(
    @Param('id') id: number,
    @Ctx() ctx: HttpContext,
    @Body(Order) order: { total: number },
    @Query('dry') dry?: boolean,
  ) { return [id, ctx.method, order, dry] }
}
`,
    })
    const generated = generateSection(await analyzeApp(app.root))
    expect(generated.diagnostics).toEqual([])
    const dry = `coerce.optional(ctx.query['dry'], 'query "dry"', coerce.boolean)`
    expect(unindent(generated.code)).toContain(
      [
        'invoke: (c: OrdersController, ctx: HttpContext) => {',
        // coerced before the body is validated, as written
        `const a0 = coerce.number(ctx.params['id'], 'param "id"')`,
        "const a2 = validate(Order, ctx.body, 'body')",
        `if (isThenable(a2)) return (async () => c.update(a0, ctx, await a2, ${dry}))()`,
        `return c.update(a0, ctx, a2, ${dry})`,
        '},',
      ].join('\n'),
    )
  })

  it('keeps @Validate(S) without @Body() async: the body is read in invoke', async () => {
    const app = tempApp({
      'src/schemas.ts': `
import { z } from 'zod'
export const Ping = z.object({ ping: z.literal(true) })
export const Page = z.coerce.number().int()
`,
      'src/ping.controller.ts': `
import { Controller, Post, Query, Validate } from '@znight/http'
import { Page, Ping } from './schemas.ts'
@Controller('/ping')
export class PingController {
  @Post()
  @Validate(Ping)
  ping(@Query('page', Page) page: number) { return page }
}
`,
    })
    const generated = generateSection(await analyzeApp(app.root))
    expect(generated.diagnostics).toEqual([])
    expect(generated.code).toContain(
      "invoke: async (c: PingController, ctx: HttpContext) => { await validate(Ping, await ctx.parseBody(), 'body'); " +
        `return c.ping(await validate(Page, ctx.query['page'], 'query "page"')) },`,
    )
    expect(generated.imports).not.toContain('isThenable from @znight/http')
  })

  it('numbers arguments by parameter index', async () => {
    const app = tempApp({
      'src/items.controller.ts': `
import { Controller, Get, Param, Query } from '@znight/http'
@Controller('/items')
export class ItemsController {
  @Get('/:id') find(@Query('verbose') verbose: boolean, @Param('id') id: string) { return { id, verbose } }
}
`,
    })
    const generated = generateSection(await analyzeApp(app.root))
    expect(generated.code).toContain(
      `invoke: (c: ItemsController, ctx: HttpContext) => c.find(coerce.boolean(ctx.query['verbose'], 'query "verbose"'), coerce.string(ctx.params['id'], 'param "id"')),`,
    )
  })
})
