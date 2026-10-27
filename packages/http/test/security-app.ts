/**
 * An application exercising CORS, security headers, trusted proxies and plugin routes (RFC 0001,
 * RFC 0002 H1), shared by the adapter matrix (`security-adapters.test.ts`) and the Node.js / Bun
 * runtime check (`fixtures/security-check.ts`).
 */
import type { ServerResponse } from 'node:http'
import type { Plugin, ZnightMetadata } from '@znight/core'
import type { FastifyReply } from 'fastify'
import type { Context } from 'hono'
import type {
  CanActivate,
  HttpContext,
  HttpPluginOptions,
  PluginHttpRoutes,
  PluginHttpRoutesContext,
  PluginRoute,
} from '../src/index.ts'

import { createRouteDecorator, HttpResponse, UnauthorizedException } from '../src/index.ts'
import { controller, metadata, provider, route, t } from './helpers.ts'

export const Open = createRouteDecorator('open', { group: 'access', required: true })
export const Keyed = createRouteDecorator('keyed', { group: 'access', required: true })

/** Counts the requests that reached a guard (a CORS preflight must never reach one). */
export const guardCalls: { count: number } = { count: 0 }

/** The access guard: `@Open()` routes pass, `@Keyed()` routes need an `x-api-key`. */
export class KeyGuard implements CanActivate {
  static readonly enforces = [Open, Keyed]
  canActivate(ctx: HttpContext): boolean {
    guardCalls.count++
    if (Open.get(ctx) === true) return true
    if (ctx.header('x-api-key') !== 'secret') {
      throw new UnauthorizedException('Missing API key', undefined, { headers: { 'www-authenticate': 'ApiKey' } })
    }
    return true
  }
}

export class SiteController {
  list() {
    return ['a', 'b']
  }
  secret() {
    return 'secret'
  }
  boom(): never {
    throw new Error('boom')
  }
  options() {
    return 'options handler'
  }
  any(ctx: HttpContext) {
    return `any ${ctx.method}`
  }
  headers(ctx: HttpContext) {
    ctx.setHeader('x-frame-options', 'SAMEORIGIN')
    ctx.setHeader('vary', 'accept')
    return 'custom headers'
  }
  client(ctx: HttpContext) {
    return { ip: ctx.ip, protocol: ctx.protocol }
  }
  redirect() {
    return HttpResponse.redirect('/api/site')
  }
  exposed() {
    return new HttpResponse('exposed', { headers: { 'access-control-expose-headers': 'x-custom' } })
  }
  raw(ctx: HttpContext, response: unknown) {
    if (ctx.adapter === 'fastify') return (response as FastifyReply).code(299).send('raw')
    if (ctx.adapter === 'hono') return (response as Context).text('raw', 299 as never)
    const res = response as ServerResponse
    res.statusCode = 299
    res.end('raw')
    return undefined
  }
}

const context = [{ index: 0, source: 'context' as const }]

/** The application metadata (every route decides the required `access` group). */
export function securityMetadata(): ZnightMetadata {
  const meta = metadata({ [t('SiteController')]: provider(SiteController), [t('KeyGuard')]: provider(KeyGuard) }, [
    controller(
      t('SiteController'),
      '/site',
      [
        route('list', '/', (c: SiteController) => c.list()),
        route('secret', '/secret', (c: SiteController) => c.secret(), { meta: { keyed: true } }),
        route('boom', '/boom', (c: SiteController) => c.boom()),
        route('options', '/opt', (c: SiteController) => c.options(), { method: 'OPTIONS', meta: { keyed: true } }),
        route('any', '/any', (c: SiteController, ctx) => c.any(ctx), {
          method: 'ALL',
          meta: { keyed: true },
          params: context,
        }),
        route('headers', '/headers', (c: SiteController, ctx) => c.headers(ctx), {
          headers: { 'content-security-policy': "default-src 'self'" },
          params: context,
        }),
        route('client', '/client', (c: SiteController, ctx) => c.client(ctx), { params: context }),
        route('redirect', '/redirect', (c: SiteController) => c.redirect()),
        route('exposed', '/exposed', (c: SiteController) => c.exposed()),
        route('raw', '/raw', (c: SiteController, ctx) => c.raw(ctx, ctx.response), {
          rawResponse: true,
          params: [
            { index: 0, source: 'context' },
            { index: 1, source: 'response' },
          ],
        }),
      ],
      { meta: { open: true } },
    ),
  ])
  return {
    ...meta,
    extensions: {
      http: {
        ...(meta.extensions?.http as object),
        groups: { access: { keys: ['keyed', 'open'], required: true } },
      },
    },
  } as unknown as ZnightMetadata
}

/** A plugin serving routes through `HttpPlugin` (the contract `@znight/openapi` uses). */
export class StatusPlugin implements Plugin, PluginHttpRoutes {
  readonly name = 'status'
  /** The context `httpRoutes()` received. */
  context: PluginHttpRoutesContext | undefined
  /** `HttpPlugin.prefix` read in `onBootstrap`, whatever the plugin order. */
  prefix: string | undefined

  onBootstrap(ctx: Parameters<NonNullable<Plugin['onBootstrap']>>[0]): void {
    this.prefix = (ctx.getPlugin('http') as { prefix: string } | undefined)?.prefix
  }

  httpRoutes(context: PluginHttpRoutesContext): readonly PluginRoute[] {
    this.context = context
    return [
      {
        method: 'GET',
        path: '/status',
        name: 'status',
        handler: ctx => ({ up: true, route: ctx.route?.path, meta: ctx.route?.meta }),
        meta: [Open.meta()],
      },
      {
        method: 'GET',
        path: '/status/files/*',
        name: 'files',
        handler: ctx => HttpResponse.ok(`file ${ctx.params['*']}`, { 'cache-control': 'public, max-age=60' }),
        meta: [Open.meta()],
      },
      {
        method: 'POST',
        path: '/status/reset',
        name: 'reset',
        handler: async ctx => ({ reset: await ctx.parseBody() }),
        meta: [Keyed.meta()],
      },
    ]
  }
}

/** Plugin options: prefix, CORS for an origin list and a preview pattern, trusted loopback proxies. */
export function securityOptions(): HttpPluginOptions {
  return {
    prefix: '/api',
    guards: [KeyGuard],
    cors: {
      origin: ['https://app.example.com', /^https:\/\/[a-z0-9-]+\.preview\.example\.com$/],
      credentials: true,
    },
    trustProxy: ['loopback'],
  }
}
