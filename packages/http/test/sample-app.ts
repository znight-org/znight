/**
 * A sample application described with hand-written metadata, shaped like the compiler output
 * (`invoke` functions mimic the generated code: coerce / validate / handler call). Shared by the
 * adapter matrix tests.
 */
import type { ServerResponse } from 'node:http'
import type { Lazy, ZnightMetadata } from '@znight/core'
import type { FastifyReply } from 'fastify'
import type { Context } from 'hono'
import type {
  CallHandler,
  CanActivate,
  ExceptionMapper,
  ExceptionMapperResult,
  HttpContext,
  HttpInterceptor,
  HttpPluginOptions,
  RequestId,
} from '../src/index.ts'

import * as v from 'valibot'
import { z } from 'zod'

import {
  coerce,
  createRouteDecorator,
  ForbiddenException,
  HttpResponse,
  NotFoundException,
  UnauthorizedException,
  validate,
} from '../src/index.ts'
import { controller, metadata, provider, route, t } from './helpers.ts'

// -------------------------------------------------------------------------------------------------
// Schemas
// -------------------------------------------------------------------------------------------------

export const CreateUser = z.object({
  name: z.string().min(1),
  email: z.email(),
  role: z.enum(['admin', 'user']).default('user'),
})
export const UpdateUser = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  age: v.optional(v.pipe(v.number(), v.integer())),
})
export const SearchQuery = z.object({ q: z.string(), limit: z.coerce.number().int().max(100).default(10) })
export const IdParam = v.pipe(v.string(), v.transform(Number), v.number(), v.integer())
export const AsyncCode = z.object({ code: z.string().refine(async value => value === 'ok', 'bad code') })

export const Roles = createRouteDecorator<readonly string[]>('roles')
export const Public = createRouteDecorator('public')

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

/** Execution trace of the current request (guards, interceptors, handler). */
export function trace(ctx: HttpContext): string[] {
  let entries = ctx.state.get('trace') as string[] | undefined
  if (entries === undefined) {
    entries = []
    ctx.state.set('trace', entries)
  }
  return entries
}

// -------------------------------------------------------------------------------------------------
// Users: params, query, body validation (zod + valibot)
// -------------------------------------------------------------------------------------------------

export class UsersController {
  list(page = 1, tags: string[] = []) {
    return { page, tags }
  }
  me() {
    return 'me'
  }
  get(id: number) {
    return { id }
  }
  byParam(id: number) {
    return { id, type: typeof id }
  }
  search(query: z.output<typeof SearchQuery>) {
    return query
  }
  create(input: z.output<typeof CreateUser>) {
    return { id: 1, ...input }
  }
  update(id: number, input: v.InferOutput<typeof UpdateUser>) {
    return { id, ...input }
  }
  remove(_id: number) {
    return undefined
  }
  checkCode(input: z.output<typeof AsyncCode>) {
    return input
  }
}

const users = controller(t('UsersController'), '/users', [
  route(
    'list',
    '/',
    (c: UsersController, ctx) =>
      c.list(
        coerce.optional(ctx.query['page'], 'query "page"', coerce.integer),
        coerce.optional(ctx.query['tag'], 'query "tag"', (value, label) => coerce.array(value, label, coerce.string)),
      ),
    {
      params: [
        { index: 0, source: 'query', name: 'page', type: 'number', optional: true },
        { index: 1, source: 'query', name: 'tag', type: 'string[]', optional: true },
      ],
    },
  ),
  route('me', '/me', (c: UsersController) => c.me()),
  route(
    'search',
    '/search',
    async (c: UsersController, ctx) => c.search(await validate(SearchQuery, ctx.query, 'query')),
    { params: [{ index: 0, source: 'query', schema: true }] },
  ),
  route('get', '/:id', (c: UsersController, ctx) => c.get(coerce.number(ctx.params['id'], 'param "id"')), {
    params: [{ index: 0, source: 'param', name: 'id', type: 'number' }],
  }),
  route(
    'byParam',
    '/:id/typed',
    async (c: UsersController, ctx) => c.byParam(await validate(IdParam, ctx.params['id'], 'param "id"')),
    { params: [{ index: 0, source: 'param', name: 'id', schema: true }] },
  ),
  route('create', '/', async (c: UsersController, ctx) => c.create(await validate(CreateUser, ctx.body, 'body')), {
    method: 'POST',
    params: [{ index: 0, source: 'body', schema: true }],
  }),
  route(
    'update',
    '/:id',
    async (c: UsersController, ctx) =>
      c.update(coerce.number(ctx.params['id'], 'param "id"'), await validate(UpdateUser, ctx.body, 'body')),
    {
      method: 'PUT',
      params: [
        { index: 0, source: 'param', name: 'id', type: 'number' },
        { index: 1, source: 'body', schema: true },
      ],
    },
  ),
  route('remove', '/:id', (c: UsersController, ctx) => c.remove(coerce.number(ctx.params['id'], 'param "id"')), {
    method: 'DELETE',
    params: [{ index: 0, source: 'param', name: 'id', type: 'number' }],
  }),
  route(
    'checkCode',
    '/code',
    async (c: UsersController, ctx) => c.checkCode(await validate(AsyncCode, ctx.body, 'body')),
    {
      method: 'POST',
      params: [{ index: 0, source: 'body', schema: true }],
    },
  ),
])

// -------------------------------------------------------------------------------------------------
// Body parsing
// -------------------------------------------------------------------------------------------------

export class BodyController {
  async echo(body: unknown) {
    if (body === undefined) return { kind: 'undefined' }
    if (typeof body === 'string') return { kind: 'string', value: body }
    if (body instanceof Uint8Array)
      return { kind: 'bytes', length: body.byteLength, text: new TextDecoder().decode(body) }
    if (body instanceof FormData) {
      const entries: Record<string, unknown> = {}
      const pending: [string, string | File][] = []
      body.forEach((value, key) => {
        pending.push([key, value])
      })
      for (const [key, value] of pending) {
        entries[key] =
          typeof value === 'string' ? value : { name: value.name, size: value.size, text: await value.text() }
      }
      return { kind: 'form-data', entries }
    }
    return { kind: 'object', value: body }
  }
  async raw(ctx: HttpContext) {
    const bytes = await ctx.rawBody()
    return { length: bytes.byteLength }
  }
  async lazy(ctx: HttpContext) {
    const before = ctx.body
    const parsed = await ctx.parseBody()
    return { before: before === undefined ? 'undefined' : 'set', parsed, after: ctx.body }
  }
}

const body = controller(t('BodyController'), '/body', [
  route('echo', '/echo', (c: BodyController, ctx) => c.echo(ctx.body), {
    method: 'POST',
    params: [{ index: 0, source: 'body' }],
  }),
  route('raw', '/raw', (c: BodyController, ctx) => c.raw(ctx), {
    method: 'POST',
    params: [{ index: 0, source: 'context' }],
  }),
  route('lazy', '/lazy', (c: BodyController, ctx) => c.lazy(ctx), {
    method: 'POST',
    params: [{ index: 0, source: 'context' }],
  }),
])

// -------------------------------------------------------------------------------------------------
// Status and serialisation
// -------------------------------------------------------------------------------------------------

export class StatusController {
  value() {
    return { ok: true }
  }
  nothing() {
    return undefined
  }
  response(status: number) {
    return new HttpResponse({ ok: true }, { status, headers: { 'x-resp': 'response' } })
  }
  text() {
    return 'hello'
  }
  bytes() {
    return new Uint8Array([104, 105])
  }
  stream() {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk1-'))
        controller.enqueue(new TextEncoder().encode('chunk2'))
        controller.close()
      },
    })
  }
  web() {
    return new Response('teapot', { status: 418, headers: { 'x-web': '1', 'content-type': 'text/x-tea' } })
  }
  null() {
    return null
  }
  redirect() {
    return HttpResponse.redirect('/status/value', 307)
  }
  headers(ctx: HttpContext) {
    ctx.setHeader('x-ctx', 'ctx')
    ctx.setHeader('x-override', 'ctx')
    return new HttpResponse({ ok: true }, { headers: { 'x-resp': 'resp', 'x-override': 'resp' } })
  }
  cookies(ctx: HttpContext) {
    ctx.appendHeader('set-cookie', 'a=1')
    ctx.appendHeader('set-cookie', 'b=2')
    return { ok: true }
  }
  bigint() {
    return { big: 1n }
  }
}

const status = controller(t('StatusController'), '/status', [
  route('value', '/value', (c: StatusController) => c.value()),
  route('value', '/created', (c: StatusController) => c.value(), { method: 'POST' }),
  route('nothing', '/empty', (c: StatusController) => c.nothing()),
  route('nothing', '/empty', (c: StatusController) => c.nothing(), { method: 'POST' }),
  route('nothing', '/empty-code', (c: StatusController) => c.nothing(), { status: 202 }),
  route('response', '/http-code', (c: StatusController) => c.response(200), {
    status: 202,
    headers: { 'x-static': 'static' },
  }),
  route('response', '/response', (c: StatusController) => c.response(203)),
  route('text', '/text', (c: StatusController) => c.text()),
  route('bytes', '/bytes', (c: StatusController) => c.bytes()),
  route('stream', '/stream', (c: StatusController) => c.stream()),
  route('web', '/web', (c: StatusController) => c.web(), { status: 200, headers: { 'x-static': 'static' } }),
  route('null', '/null', (c: StatusController) => c.null()),
  route('redirect', '/redirect', (c: StatusController) => c.redirect()),
  route('headers', '/headers', (c: StatusController, ctx) => c.headers(ctx), {
    headers: { 'x-static': 'static', 'x-override': 'static' },
    params: [{ index: 0, source: 'context' }],
  }),
  route('cookies', '/cookies', (c: StatusController, ctx) => c.cookies(ctx), {
    params: [{ index: 0, source: 'context' }],
  }),
  route('bigint', '/bigint', (c: StatusController) => c.bigint()),
])

// -------------------------------------------------------------------------------------------------
// Guards and interceptors
// -------------------------------------------------------------------------------------------------

/** Global guard (plugin option, as a class): enforces a bearer token on `secured` routes unless `@Public()`. */
export class AuthGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    if (ctx.route?.meta['secured'] !== true) return true
    if (Public.get(ctx) === true) {
      trace(ctx).push('auth:public')
      return true
    }
    trace(ctx).push('auth')
    if (ctx.header('Authorization') !== 'Bearer ok') {
      throw new UnauthorizedException('Missing token', undefined, { headers: { 'www-authenticate': 'Bearer' } })
    }
    return true
  }
}

export class ControllerGuard implements CanActivate {
  async canActivate(ctx: HttpContext): Promise<boolean> {
    trace(ctx).push('controller')
    await Promise.resolve()
    return ctx.header('x-deny') !== 'controller'
  }
}

export class RolesGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    trace(ctx).push('roles')
    ctx.setHeader('x-guard', 'roles')
    const roles = Roles.get(ctx) ?? []
    return roles.includes(ctx.header('x-role') ?? '')
  }
}

function tracing(name: string): HttpInterceptor {
  return {
    async intercept(ctx: HttpContext, next: CallHandler) {
      trace(ctx).push(`${name}:before`)
      const result = await next()
      trace(ctx).push(`${name}:after`)
      return result
    },
  }
}

export class ControllerInterceptor implements HttpInterceptor {
  readonly #inner = tracing('controller')
  intercept(ctx: HttpContext, next: CallHandler): unknown {
    return this.#inner.intercept(ctx, next)
  }
}

export class RouteInterceptor implements HttpInterceptor {
  readonly #inner = tracing('route')
  intercept(ctx: HttpContext, next: CallHandler): unknown {
    return this.#inner.intercept(ctx, next)
  }
}

/** Wraps the result. */
export class WrapInterceptor implements HttpInterceptor {
  async intercept(_ctx: HttpContext, next: CallHandler): Promise<unknown> {
    return { data: await next() }
  }
}

/** Short-circuits when `x-cache: hit`. */
export class CacheInterceptor implements HttpInterceptor {
  intercept(ctx: HttpContext, next: CallHandler): unknown {
    if (ctx.header('x-cache') === 'hit') return { cached: true }
    return next()
  }
}

export class GuardedController {
  trace(ctx: HttpContext) {
    trace(ctx).push('handler')
    return trace(ctx)
  }
  value() {
    return 'value'
  }
}

const guarded = controller(
  t('GuardedController'),
  '/guarded',
  [
    route('trace', '/open', (c: GuardedController, ctx) => c.trace(ctx), {
      meta: { public: true },
      params: [{ index: 0, source: 'context' }],
    }),
    route('trace', '/roles', (c: GuardedController, ctx) => c.trace(ctx), {
      meta: { roles: ['admin'] },
      guards: [t('RolesGuard')],
      params: [{ index: 0, source: 'context' }],
    }),
    route('trace', '/interceptors', (c: GuardedController, ctx) => c.trace(ctx), {
      meta: { public: true },
      interceptors: [t('RouteInterceptor')],
      params: [{ index: 0, source: 'context' }],
    }),
    route('value', '/wrapped', (c: GuardedController) => c.value(), {
      meta: { public: true },
      interceptors: [t('WrapInterceptor')],
    }),
    route('value', '/cached', (c: GuardedController) => c.value(), {
      meta: { public: true },
      interceptors: [t('CacheInterceptor')],
    }),
  ],
  {
    guards: [t('ControllerGuard')],
    interceptors: [t('ControllerInterceptor')],
    meta: { secured: true, area: 'admin' },
  },
)

// -------------------------------------------------------------------------------------------------
// Errors and exception mappers
// -------------------------------------------------------------------------------------------------

export class DomainError extends Error {}
export class TeapotError extends Error {}
export class WebError extends Error {}
export class BrokenError extends Error {}

/** Mapper given as a class (resolved from the container). */
export class DomainErrorMapper implements ExceptionMapper {
  map(error: unknown): ExceptionMapperResult {
    if (error instanceof DomainError) return new HttpResponse({ conflict: error.message }, { status: 409 })
    if (error instanceof BrokenError) throw new Error('mapper bug')
    return undefined
  }
}

/** Mapper given as an instance. */
export const teapotMapper: ExceptionMapper = {
  async map(error: unknown): Promise<ExceptionMapperResult> {
    await Promise.resolve()
    if (error instanceof TeapotError) return new HttpResponse({ tea: true }, { status: 418 })
    if (error instanceof WebError) return new Response('mapped', { status: 451 })
    if (error instanceof NotFoundException && error.message.startsWith('Cannot')) {
      return new NotFoundException(`No route for ${error.message.slice('Cannot '.length)}`)
    }
    return undefined
  },
}

export class ErrorsController {
  domain(): never {
    throw new DomainError('already exists')
  }
  teapot(): never {
    throw new TeapotError()
  }
  web(): never {
    throw new WebError()
  }
  broken(): never {
    throw new BrokenError('broken')
  }
  boom(): never {
    throw new Error('secret details')
  }
  async rejected(): Promise<never> {
    await Promise.resolve()
    throw new Error('async secret')
  }
  http(): never {
    throw new NotFoundException('nope', { id: 1 })
  }
  forbidden(ctx: HttpContext): never {
    ctx.setHeader('x-guard', 'set-before-throw')
    throw new ForbiddenException()
  }
}

const errors = controller(t('ErrorsController'), '/errors', [
  route('domain', '/domain', (c: ErrorsController) => c.domain()),
  route('teapot', '/teapot', (c: ErrorsController) => c.teapot()),
  route('web', '/web', (c: ErrorsController) => c.web()),
  route('broken', '/broken', (c: ErrorsController) => c.broken()),
  route('boom', '/boom', (c: ErrorsController) => c.boom()),
  route('rejected', '/rejected', (c: ErrorsController) => c.rejected()),
  route('http', '/http', (c: ErrorsController) => c.http()),
  route('forbidden', '/forbidden', (c: ErrorsController, ctx) => c.forbidden(ctx), {
    params: [{ index: 0, source: 'context' }],
  }),
])

// -------------------------------------------------------------------------------------------------
// Request scope
// -------------------------------------------------------------------------------------------------

export const scopeStats = { controllers: 0, states: 0, disposed: 0 }

export class RequestState {
  readonly ctx: HttpContext
  readonly requestId: RequestId
  constructor(ctx: HttpContext, requestId: RequestId) {
    this.ctx = ctx
    this.requestId = requestId
    scopeStats.states++
  }
  [Symbol.dispose](): void {
    scopeStats.disposed++
  }
}

export class ScopedController {
  readonly #state: RequestState
  readonly instance: number
  constructor(state: RequestState) {
    this.#state = state
    this.instance = ++scopeStats.controllers
  }
  get() {
    return {
      requestId: this.#state.requestId,
      ctxRequestId: this.#state.ctx.requestId,
      path: this.#state.ctx.path,
      instance: this.instance,
    }
  }
}

export class AuditService {
  readonly #ctx: Lazy<HttpContext>
  constructor(ctx: Lazy<HttpContext>) {
    this.#ctx = ctx
  }
  current() {
    return this.#ctx.get().requestId
  }
}

export class AuditController {
  readonly #audit: AuditService
  constructor(audit: AuditService) {
    this.#audit = audit
  }
  get() {
    return { requestId: this.#audit.current() }
  }
}

const scoped = controller(t('ScopedController'), '/scoped', [route('get', '/', (c: ScopedController) => c.get())])
const audit = controller(t('AuditController'), '/audit', [route('get', '/', (c: AuditController) => c.get())])

// -------------------------------------------------------------------------------------------------
// Routing features
// -------------------------------------------------------------------------------------------------

export class MiscController {
  rest(ctx: HttpContext) {
    return { rest: ctx.params['*'] }
  }
  method(ctx: HttpContext) {
    return `any ${ctx.method}`
  }
  explicitGet() {
    return 'explicit get'
  }
  headGet() {
    return 'get body'
  }
  head(ctx: HttpContext) {
    ctx.setHeader('x-head', 'explicit')
    return undefined
  }
  raw(ctx: HttpContext, response: unknown) {
    if (ctx.adapter === 'fastify') {
      return (response as FastifyReply).code(299).header('x-raw', 'fastify').send('raw fastify')
    }
    if (ctx.adapter === 'hono') return (response as Context).text('raw hono', 299 as never, { 'x-raw': 'hono' })
    const res = response as ServerResponse
    res.statusCode = 299
    res.setHeader('x-raw', ctx.adapter)
    res.end(`raw ${ctx.adapter}`)
    return undefined
  }
  requestId(ctx: HttpContext) {
    return { requestId: ctx.requestId }
  }
  query(query: Record<string, string | string[]>) {
    return query
  }
  header(value: number | undefined) {
    return { value: value ?? null }
  }
  context(ctx: HttpContext) {
    return { adapter: ctx.adapter, route: ctx.route, ip: typeof ctx.ip, method: ctx.method, url: ctx.url }
  }
  paramsAll(id: string, slug: string) {
    return { id, slug }
  }
  me() {
    return 'static me'
  }
}

const misc = controller(t('MiscController'), '/misc', [
  route('rest', '/files/*', (c: MiscController, ctx) => c.rest(ctx), { params: [{ index: 0, source: 'context' }] }),
  route('method', '/any', (c: MiscController, ctx) => c.method(ctx), {
    method: 'ALL',
    params: [{ index: 0, source: 'context' }],
  }),
  route('explicitGet', '/any', (c: MiscController) => c.explicitGet()),
  route('headGet', '/head', (c: MiscController) => c.headGet()),
  route('head', '/head', (c: MiscController, ctx) => c.head(ctx), {
    method: 'HEAD',
    params: [{ index: 0, source: 'context' }],
  }),
  route('raw', '/raw', (c: MiscController, ctx) => c.raw(ctx, ctx.response), {
    rawResponse: true,
    params: [
      { index: 0, source: 'context' },
      { index: 1, source: 'response' },
    ],
  }),
  route('requestId', '/request-id', (c: MiscController, ctx) => c.requestId(ctx), {
    params: [{ index: 0, source: 'context' }],
  }),
  route('query', '/query', (c: MiscController, ctx) => c.query(ctx.query as never), {
    params: [{ index: 0, source: 'query' }],
  }),
  route(
    'header',
    '/header',
    (c: MiscController, ctx) => c.header(coerce.optional(ctx.headers['x-num'], 'header "x-num"', coerce.number)),
    { params: [{ index: 0, source: 'headers', name: 'x-num', type: 'number', optional: true }] },
  ),
  route('context', '/context', (c: MiscController, ctx) => c.context(ctx), {
    meta: { feature: 'context' },
    params: [{ index: 0, source: 'context' }],
  }),
  route(
    'paramsAll',
    '/items/:id/:slug',
    (c: MiscController, ctx) =>
      c.paramsAll(coerce.string(ctx.params['id'], 'param "id"'), coerce.string(ctx.params['slug'], 'param "slug"')),
    {
      params: [
        { index: 0, source: 'param', name: 'id', type: 'string' },
        { index: 1, source: 'param', name: 'slug', type: 'string' },
      ],
    },
  ),
  route('me', '/items/me/static', (c: MiscController) => c.me()),
])

// -------------------------------------------------------------------------------------------------
// Metadata
// -------------------------------------------------------------------------------------------------

const HTTP_CONTEXT = '@znight/http#HttpContext'
const REQUEST_ID = '@znight/http#RequestId'

/** The sample application metadata. */
export function sampleMetadata(): ZnightMetadata {
  return metadata(
    {
      [t('UsersController')]: provider(UsersController),
      [t('BodyController')]: provider(BodyController),
      [t('StatusController')]: provider(StatusController),
      [t('AuthGuard')]: provider(AuthGuard),
      [t('ControllerGuard')]: provider(ControllerGuard),
      [t('RolesGuard')]: provider(RolesGuard, [], 'request'),
      [t('ControllerInterceptor')]: provider(ControllerInterceptor),
      [t('RouteInterceptor')]: provider(RouteInterceptor, [], 'transient'),
      [t('WrapInterceptor')]: provider(WrapInterceptor),
      [t('CacheInterceptor')]: provider(CacheInterceptor),
      [t('GuardedController')]: provider(GuardedController),
      [t('DomainErrorMapper')]: provider(DomainErrorMapper),
      [t('ErrorsController')]: provider(ErrorsController),
      [t('RequestState')]: provider(RequestState, [HTTP_CONTEXT, REQUEST_ID], 'request'),
      [t('ScopedController')]: provider(ScopedController, [t('RequestState')], 'request'),
      [t('AuditService')]: provider(AuditService, [{ lazy: HTTP_CONTEXT }]),
      [t('AuditController')]: provider(AuditController, [t('AuditService')]),
      [t('MiscController')]: provider(MiscController),
    },
    [users, body, status, guarded, errors, scoped, audit, misc],
  )
}

/** Plugin options of the sample application (global guard, interceptor and mappers). */
export function sampleOptions(): HttpPluginOptions {
  return {
    guards: [AuthGuard],
    interceptors: [tracing('global')],
    exceptionMappers: [DomainErrorMapper, teapotMapper],
    bodyLimit: 1024,
  }
}
