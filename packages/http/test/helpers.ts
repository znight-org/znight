import type {
  CoreLogger,
  DependencyRef,
  ExternalDefinition,
  LogContext,
  ProviderDefinition,
  Scope,
  Token,
  ZnightMetadata,
} from '@znight/core'
import type {
  HttpAdapter,
  HttpContext,
  HttpControllerDefinition,
  HttpPluginOptions,
  HttpRouteDefinition,
  InjectRequest,
  InjectResponse,
} from '../src/index.ts'

import { Application, type ApplicationOptions } from '@znight/core'

import { expressAdapter } from '../src/adapters/express.ts'
import { fastifyAdapter } from '../src/adapters/fastify.ts'
import { honoAdapter } from '../src/adapters/hono.ts'
import { nodeAdapter } from '../src/adapters/node.ts'
import { normalizeInject } from '../src/adapters/shared.ts'
import { HttpPlugin } from '../src/index.ts'

/** Token of a test provider declared in `src/app.ts`. */
export function t(name: string): Token {
  return `src/app.ts#${name}`
}

type Ctor = new (...args: never[]) => unknown

/** A provider definition for a class: `factory: d => new cls(...d)`. */
export function provider<C extends Ctor>(
  cls: C,
  deps: readonly DependencyRef[] = [],
  scope: Scope = 'singleton',
  extra: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    scope,
    class: cls as unknown as ProviderDefinition['class'],
    deps,
    factory: (resolved: unknown[]) => new cls(...(resolved as never[])),
    ...extra,
  }
}

/** A route definition with defaults (GET, no guards...). `invoke` mimics the generated code. */
export function route(
  handler: string,
  path: string,
  // biome-ignore lint/suspicious/noExplicitAny: mimics generated invoke functions
  invoke: (controller: any, ctx: HttpContext) => unknown,
  extra: Partial<HttpRouteDefinition> = {},
): HttpRouteDefinition {
  return {
    method: 'GET',
    path,
    fullPath: path,
    handler,
    meta: {},
    guards: [],
    interceptors: [],
    params: [],
    invoke,
    ...extra,
  }
}

/** A controller definition; route `fullPath`s are recomputed from `basePath`. */
export function controller(
  token: Token,
  basePath: string,
  routes: readonly HttpRouteDefinition[],
  extra: Partial<HttpControllerDefinition> = {},
): HttpControllerDefinition {
  const base = basePath === '/' ? '' : basePath
  return {
    token,
    basePath,
    guards: [],
    interceptors: [],
    meta: {},
    routes: routes.map(r => ({ ...r, fullPath: r.path === '/' ? base || '/' : `${base}${r.path}` })),
    ...extra,
  }
}

function hardDeps(definition: ProviderDefinition): Token[] {
  const tokens: Token[] = []
  for (const ref of definition.deps) {
    if (typeof ref === 'string') tokens.push(ref)
    else if ('multi' in ref) tokens.push(...ref.multi)
    else if ('token' in ref) tokens.push(ref.token)
  }
  return tokens
}

/** Deterministic topological order (dependencies first), like the compiler's `resolutionOrder`. */
export function topologicalOrder(providers: Readonly<Record<Token, ProviderDefinition>>): Token[] {
  const order: Token[] = []
  const state = new Map<Token, number>()
  const visit = (token: Token): void => {
    if (state.get(token) === 2 || !Object.hasOwn(providers, token)) return
    if (state.get(token) === 1) return
    state.set(token, 1)
    for (const dep of hardDeps(providers[token] as ProviderDefinition)) visit(dep)
    state.set(token, 2)
    order.push(token)
  }
  for (const token of Object.keys(providers).sort()) visit(token)
  return order
}

/** Hand-written metadata, shaped like the compiler output. */
export function metadata(
  providers: Readonly<Record<Token, ProviderDefinition>>,
  controllers: readonly HttpControllerDefinition[],
  externals: readonly ExternalDefinition[] = [],
): ZnightMetadata {
  return {
    version: 1,
    compiler: '0.1.0',
    providers,
    resolutionOrder: topologicalOrder(providers),
    externals: [
      { token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
      { token: '@znight/http#RequestId', scope: 'request', providedBy: 'HttpPlugin' },
      ...externals,
    ],
    extensions: { http: { controllers } },
  }
}

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly context: LogContext | undefined
}

/** A logger recording every entry. */
export function memoryLogger(): CoreLogger & { readonly entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    entries,
    debug: (message, context) => entries.push({ level: 'debug', message, context }),
    info: (message, context) => entries.push({ level: 'info', message, context }),
    warn: (message, context) => entries.push({ level: 'warn', message, context }),
    error: (message, context) => entries.push({ level: 'error', message, context }),
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Captures the error thrown by `fn` (sync or async). Fails when nothing is thrown. */
export async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected an error to be thrown')
}

/** Every adapter, by name. */
export const ADAPTERS: readonly { readonly name: string; readonly create: () => HttpAdapter }[] = [
  { name: 'node', create: () => nodeAdapter() },
  { name: 'fastify', create: () => fastifyAdapter() },
  { name: 'express', create: () => expressAdapter() },
  { name: 'hono', create: () => honoAdapter() },
]

/** Sends a request to a running application. */
export type Send = (request: InjectRequest) => Promise<InjectResponse>

/** In-memory transport (`plugin.inject`). */
export function viaInject(http: HttpPlugin): Send {
  return request => http.inject(request)
}

/** Network transport (`fetch` against the listening server, redirects not followed). */
export function viaFetch(http: HttpPlugin): Send {
  return async request => {
    const normalized = await normalizeInject(request)
    const init: RequestInit = { method: normalized.method, headers: normalized.headers, redirect: 'manual' }
    if (normalized.payload !== undefined) init.body = normalized.payload
    const response = await fetch(`${String(http.address)}${normalized.url}`, init)
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value
    const cookies = response.headers.getSetCookie()
    if (cookies.length > 0) headers['set-cookie'] = cookies
    const bytes = new Uint8Array(await response.arrayBuffer())
    const body = new TextDecoder().decode(bytes)
    return { status: response.status, headers, body, bytes, json: <T>() => JSON.parse(body) as T }
  }
}

export const TRANSPORTS: readonly { readonly name: string; readonly create: (http: HttpPlugin) => Send }[] = [
  { name: 'inject', create: viaInject },
  { name: 'fetch', create: viaFetch },
]

export interface TestApp {
  readonly app: Application
  readonly http: HttpPlugin
  readonly logger: ReturnType<typeof memoryLogger>
  stop(): Promise<void>
}

/** Creates (and by default starts on a free port) an application with the HTTP plugin. */
export async function createApp(
  meta: ZnightMetadata,
  options: HttpPluginOptions = {},
  extra: Partial<ApplicationOptions> & { readonly start?: boolean } = {},
): Promise<TestApp> {
  const logger = memoryLogger()
  const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', ...options })
  const { start = true, ...appOptions } = extra
  const app = await Application.create({
    logger,
    shutdown: { signals: false },
    ...appOptions,
    metadata: meta,
    plugins: [http, ...(appOptions.plugins ?? [])],
  })
  if (start) await app.start()
  return { app, http, logger, stop: () => app.stop() }
}
