/**
 * `@znight/graphql/yoga`: the GraphQL Yoga driver (RFC 0009 §5.1). GraphQL Yoga 6 serves the schema
 * of `GraphQLPlugin` (its protocol, Envelop plugins, GraphiQL, SSE subscriptions) and hands every
 * document to Znight's engine, which parses it through its document cache, validates it with its
 * limits, and executes it with the application's guards, loaders, request scope, error masking and
 * hook. Mounted as plugin routes of `HttpPlugin`: the HTTP pipeline (request scope, hooks, guards,
 * CORS, security headers, drain) wraps every request, on every adapter, on Node.js and Bun.
 *
 * Needs `graphql-yoga` (an optional peer dependency of `@znight/graphql`), only loaded by this entry.
 */
import type { CoreLogger } from '@znight/core'
import type { HeaderValue, HttpContext } from '@znight/http'
import type { DocumentNode, ExecutionArgs, ExecutionResult, GraphQLSchema, ValidationRule } from 'graphql'
import type {
  GraphiQLOptions,
  YogaInitialContext,
  Plugin as YogaPlugin,
  YogaServerInstance,
  YogaServerOptions,
} from 'graphql-yoga'
import type { GraphQLDriver, GraphQLDriverContext, GraphQLDriverRoute, GraphQLDriverRoutesContext } from './driver.ts'
import type { EngineExecuteOptions, GraphQLEngine } from './engine.ts'
import type { GraphQLContext } from './types.ts'

import { ErrorCode, ZnightError } from '@znight/core'
import { HttpResponse, parseByteSize } from '@znight/http'
import { GraphQLError } from 'graphql'
import { createYoga } from 'graphql-yoga'

import { GraphQLErrorCode } from './errors.ts'
import { MEDIA, Media, type MediaKind, negotiate } from './transport/accept.ts'
import { fetchRequest, type RequestClass } from './transport/fetch.ts'
import { isJsonRequest, notJson } from './transport/http.ts'

/** The server context the driver gives Yoga: the `HttpContext` of the route, as `znight`. */
export interface YogaServerContext {
  readonly znight: HttpContext
}

/**
 * Yoga's context of an operation: its initial context (`request`, `params`, `log`) and the server
 * context of the driver. What {@link yogaContext} returns.
 */
export type YogaContext = YogaInitialContext & YogaServerContext

/** Options of Yoga the engine or `GraphQLPlugin` own (RFC 0009 §4.6): refused by {@link yogaDriver}. */
const OWNED = [
  'schema',
  'context',
  'graphqlEndpoint',
  'maskedErrors',
  'cors',
  'fetchAPI',
  'maxRequestBodySize',
  'parserAndValidationCache',
  'requestId',
  'healthCheckEndpoint',
  'landingPage',
  'disposeOnProcessTerminate',
  'batching',
  'multipart',
] as const

/** Where each owned option comes from, for the ZNIGHT066 hint. */
const OWNER: Readonly<Record<(typeof OWNED)[number], string>> = {
  schema: 'the engine serves the schema GraphQLPlugin built',
  context: "resolvers get GraphQLContext; read Yoga's context with yogaContext(ctx)",
  graphqlEndpoint: 'set the path option of GraphQLPlugin',
  maskedErrors: 'the engine masks errors once (exposeErrors, errorMappers)',
  cors: 'set the cors option of HttpPlugin',
  fetchAPI: "Yoga keeps its default Fetch API; the driver converts Yoga's responses for HttpPlugin",
  maxRequestBodySize: 'set http.bodyLimit of GraphQLPlugin',
  parserAndValidationCache: 'the engine caches documents (the documentCache option of GraphQLPlugin)',
  requestId: 'Yoga uses the request id of HttpPlugin',
  healthCheckEndpoint: 'the driver only serves the GraphQL endpoint',
  landingPage: 'the driver only serves the GraphQL endpoint',
  disposeOnProcessTerminate: 'the application stops Yoga once HttpPlugin drained its requests',
  batching:
    'Send one operation per request: the operations of a batch would share the request scope and its GraphQLContext',
  multipart:
    'POST bodies are application/json only: form and multipart bodies skip the CORS preflight (CSRF); upload files through an HTTP controller',
}

/**
 * Options of {@link yogaDriver}: Yoga's own (`plugins`, `logging`, `allowedHeaders`...), except
 * those the engine, `GraphQLPlugin` or `HttpPlugin` own: the schema, the context, the endpoint
 * (`path`), masking (`exposeErrors`), CORS, the body limit (`http.bodyLimit`), the document cache,
 * the request id and the IDE switch (`graphiql`); and those the driver refuses: `batching` (one
 * operation per request scope) and `multipart` (JSON bodies only, see {@link yogaDriver}). Yoga's
 * `logging` is off unless set: requests and operations are logged by Znight.
 */
export interface YogaDriverOptions
  extends Omit<YogaServerOptions<YogaServerContext, Record<string, unknown>>, (typeof OWNED)[number] | 'graphiql'> {
  /**
   * GraphiQL's options (title, default query...), when the `graphiql` option of `GraphQLPlugin` is
   * on (it decides whether the IDE is served).
   */
  readonly graphiql?: GraphiQLOptions
}

/** A GraphQL Yoga driver: `GraphQLPlugin.configure({ driver: yogaDriver() })`. */
export interface YogaDriver extends GraphQLDriver {
  readonly name: 'yoga'
  /** The Yoga server, once started (`undefined` before `start()` and after `stop()`). */
  readonly yoga: YogaServerInstance<YogaServerContext, Record<string, unknown>> | undefined
}

/**
 * The GraphQL Yoga driver (RFC 0009 §5.1): `GraphQLPlugin.configure({ driver: yogaDriver({ plugins }) })`.
 * Yoga handles the protocol and its Envelop plugins; the engine parses, validates and executes
 * (guards, loaders, request scope, masking, the `graphql:operation` hook). Plugins that replace
 * the engine's execution (`useGraphQlJit`) are refused: the operation fails with ZNIGHT066.
 *
 * Like the built-in transport, a `POST` body is `application/json` only (415 otherwise): form,
 * multipart and text bodies, which a cross-site page sends without a CORS preflight, never run
 * an operation (CSRF). Errors thrown outside the engine (by Yoga or an Envelop plugin) are masked
 * like the engine's (`Unexpected error.` unless `exposeErrors`) and logged.
 *
 * A response cache hit answers without the engine: guards, loaders, error mappers and the
 * `graphql:operation` hook do not run. Key the cache per principal (`session`), never globally
 * next to guards:
 *
 * ```ts
 * GraphQLPlugin.configure({
 *   guards: [AccessGuard],
 *   driver: yogaDriver({
 *     plugins: [useResponseCache({ session: request => request.headers.get('authorization') })],
 *   }),
 * })
 * ```
 */
export function yogaDriver(options: YogaDriverOptions = {}): YogaDriver {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalid('yogaDriver(): expected an options object', ['yogaDriver({ plugins: [...] })'])
  }
  for (const key of OWNED) {
    if ((options as Record<string, unknown>)[key] !== undefined) {
      throw invalid(`yogaDriver(): the ${key} option of Yoga is not available with Znight`, [OWNER[key]])
    }
  }
  const graphiql: unknown = options.graphiql
  if (graphiql !== undefined && (graphiql === null || typeof graphiql !== 'object')) {
    throw invalid("yogaDriver(): graphiql takes GraphiQL's options", [
      'Turn the IDE on or off with the graphiql option of GraphQLPlugin',
    ])
  }
  if (options.plugins !== undefined && !Array.isArray(options.plugins)) {
    throw invalid('yogaDriver(): plugins must be an array of Envelop plugins', [])
  }
  return new Driver(options)
}

/**
 * Yoga's context of an operation received by the Yoga driver (RFC 0009 Q2): `GraphQLContext.serverContext`,
 * typed. For the rare resolver that needs Yoga's `request`, `params` or the context an Envelop
 * plugin extended; the HTTP request is `ctx.http`, the user a request-scoped provider.
 *
 * @throws ZnightError (ZNIGHT066) when the operation did not come through the Yoga driver.
 */
export function yogaContext<TContext extends Record<string, unknown> = Record<string, unknown>>(
  ctx: GraphQLContext,
): YogaContext & TContext {
  const server = ctx?.serverContext as Partial<YogaContext> | undefined
  if (server === null || typeof server !== 'object' || server.znight === undefined || server.params === undefined) {
    throw invalid('yogaContext(): the operation was not received by the Yoga driver', [
      'yogaContext() reads GraphQLContext.serverContext of operations served by yogaDriver()',
    ])
  }
  return server as YogaContext & TContext
}

// ------------------------------------------------------------------------------------------------

type Yoga = YogaServerInstance<YogaServerContext, Record<string, unknown>>

const SSE: EngineExecuteOptions = Object.freeze({ transport: 'sse' })
const DEFAULT_BODY_LIMIT = 1024 * 1024

class Driver implements YogaDriver {
  readonly name = 'yoga' as const
  readonly #options: YogaDriverOptions
  #yoga: Yoga | undefined
  /** Stopped: the application stops, requests that still reach the driver get a 503. */
  #stopped = false
  #get = true
  #ide = false
  #limit = DEFAULT_BODY_LIMIT

  constructor(options: YogaDriverOptions) {
    this.#options = options
  }

  get yoga(): Yoga | undefined {
    return this.#yoga
  }

  /** `GET` and `POST` on the path (`GET` answers 405 when neither queries over `GET` nor GraphiQL apply). */
  routes(context: GraphQLDriverRoutesContext): readonly GraphQLDriverRoute[] {
    return [
      { method: 'GET', path: context.path, name: 'yoga', handler: this.#getHandler },
      { method: 'POST', path: context.path, name: 'yoga', handler: this.#postHandler },
    ]
  }

  start(engine: GraphQLEngine, context: GraphQLDriverContext): void {
    if (this.#yoga !== undefined) {
      throw invalid('yogaDriver(): this driver already serves an application', [
        'Create one driver per application: GraphQLPlugin.configure({ driver: yogaDriver() })',
      ])
    }
    const settings = engine.settings
    const http = settings.http
    this.#get = http !== false && http.get
    this.#ide = settings.ide
    this.#limit = http === false ? DEFAULT_BODY_LIMIT : (parseByteSize(http.bodyLimit) ?? DEFAULT_BODY_LIMIT)
    const { graphiql, plugins = [], logging = false, ...rest } = this.#options
    const engineFns = engineFunctions(engine, context.logger)
    this.#yoga = createYoga<YogaServerContext, Record<string, unknown>>({
      ...rest,
      logging,
      schema: engine.schema,
      graphqlEndpoint: settings.path,
      graphiql: settings.ide ? (graphiql ?? true) : false,
      landingPage: false,
      healthCheckEndpoint: UNREACHABLE,
      // the engine masked its errors (kept as they are); those thrown outside of it are masked here
      maskedErrors: { maskError: outsideErrors(settings.exposeErrors, context.logger) },
      batching: false,
      multipart: false,
      cors: false, // HttpPlugin's CORS
      // the Fetch bridge reads the body under the route's limit (HttpPlugin's 413): Yoga's own limit
      // would pipe every body through a counting stream
      maxRequestBodySize: false,
      parserAndValidationCache: false, // the engine's document cache
      disposeOnProcessTerminate: false,
      requestId: { generateRequestId: requestIdOf, trustHeader: false },
      // Yoga's default Fetch API (the fastest on each runtime): httpReply() converts its responses
      plugins: [engineFns.plugin, ...plugins, engineFns.guard],
    })
    this.#stopped = false
  }

  /** Called once `HttpPlugin` drained the requests (`GraphQLPlugin.onDispose`). */
  async stop(): Promise<void> {
    const yoga = this.#yoga
    this.#yoga = undefined
    this.#stopped = true
    await yoga?.dispose()
  }

  readonly #handle = (ctx: HttpContext): Response | Promise<HttpResponse<unknown>> => {
    const yoga = this.#yoga
    if (yoga === undefined) {
      if (this.#stopped) return shuttingDown()
      throw notStarted()
    }
    const request = fetchRequest(ctx, this.#limit, yoga.fetchAPI.Request as RequestClass)
    const server: YogaServerContext = { znight: ctx }
    // Yoga may answer synchronously, or with a thenable of its own: settled as a native promise
    if (request instanceof Promise) return request.then(built => yoga.fetch(built, server)).then(httpReply)
    return Promise.resolve(yoga.fetch(request, server)).then(httpReply)
  }

  /** `POST`: JSON bodies only (the 415 of the built-in transport otherwise: no CSRF). */
  readonly #postHandler = (ctx: HttpContext): unknown => {
    const headers = ctx.headers
    if (!isJsonRequest(headers['content-type'])) return notJson(jsonMedia(headers['accept']))
    return this.#handle(ctx)
  }

  /** `GET`: Yoga's, or 405 when queries over `GET` are off (GraphiQL pages still served). */
  readonly #getHandler = (ctx: HttpContext): Response | Promise<HttpResponse<unknown>> => {
    if (this.#get || (this.#ide && acceptsHtml(ctx))) return this.#handle(ctx)
    return getNotAllowed()
  }
}

/** A path no request reaches: the driver's routes only serve the GraphQL endpoint. */
const UNREACHABLE = '/.znight/unreachable'

/**
 * What `HttpPlugin` sends for a response of Yoga, whatever Fetch API made it (Yoga's default: the
 * `@whatwg-node` ponyfills on Node.js, the runtime's own on Bun; a `@hono/node-server` class...):
 * an `HttpResponse` with its status and headers (`set-cookie` lines kept apart) and
 *
 * - its text, for a JSON, HTML or plain text body in UTF-8, not content-encoded (Yoga's results,
 *   GraphiQL, its errors): complete once the response exists (a ponyfill response holds the
 *   string), it is sent with a `content-length`, never streamed;
 * - otherwise its body as a native `ReadableStream`, its bytes as they are (a body compressed by a
 *   plugin such as `useContentEncoding()`, another charset), read as the client receives it and
 *   cancelled when the client leaves (GraphQL over SSE, incremental delivery): never buffered.
 */
function httpReply(response: Response): HttpResponse<unknown> | Promise<HttpResponse<unknown>> {
  const headers = responseHeaders(response.headers)
  const init = { status: response.status, headers }
  if (isUtf8Text(headers)) {
    delete headers['content-length'] // the length of the text, set by HttpPlugin
    return response.text().then(text => new HttpResponse(text, init))
  }
  const body = response.body
  return new HttpResponse(body === null ? undefined : nativeStream(body), init)
}

/** The headers of a response as `HttpResponse` headers: each name once, `set-cookie` as its lines. */
function responseHeaders(source: Headers): Record<string, HeaderValue> {
  const headers: Record<string, HeaderValue> = Object.create(null)
  source.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value
  })
  const cookies = source.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  return headers
}

/** Media types whose body is complete with the response (JSON, HTML, plain text): sent as text. */
const TEXT_TYPE = /^\s*(?:application\/(?:[\w.-]+\+)?json|text\/(?:html|plain))\s*(?:;|$)/i

/** The `charset` parameter of a media type (quoted or not). */
const CHARSET = /;\s*charset\s*=\s*"?([^";\s]*)/i

/**
 * Whether a body is sent as its text: a {@link TEXT_TYPE} in UTF-8 (no charset, or `utf-8`) and
 * not content-encoded (no `content-encoding`, or `identity`). Decoding compressed bytes, or text in
 * another charset, as UTF-8 would corrupt them: such a body is streamed as it is.
 */
function isUtf8Text(headers: Record<string, HeaderValue>): boolean {
  const type = headers['content-type']
  if (typeof type !== 'string' || !TEXT_TYPE.test(type)) return false
  const encoding = headers['content-encoding']
  if (encoding !== undefined && (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'identity')) {
    return false
  }
  const charset = CHARSET.exec(type)?.[1]
  return charset === undefined || /^utf-?8$/i.test(charset)
}

/** A native `ReadableStream` reading `body` (another implementation's stream: the ponyfill's). */
function nativeStream(body: Pick<ReadableStream<Uint8Array>, 'getReader'>): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      },
      cancel: reason => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  )
}

/** The request id of `HttpPlugin` (a UUID for a request handed to `yoga.fetch()` directly). */
function requestIdOf(payload: { readonly context: Partial<YogaServerContext> }): string {
  return payload.context.znight?.requestId ?? crypto.randomUUID()
}

function acceptsHtml(ctx: HttpContext): boolean {
  return ctx.headers['accept']?.includes('text/html') === true
}

/** The JSON type a refusal is written in, like the built-in transport: `application/json` unless the client prefers `application/graphql-response+json`. */
function jsonMedia(accept: string | undefined): MediaKind {
  const media = (negotiate(accept, (1 << Media.GraphQLJson) | (1 << Media.Json)) & MEDIA) as MediaKind
  return media === Media.None ? Media.Json : media
}

/** A request reaching the driver once it stopped (after `HttpPlugin` drained): 503. */
function shuttingDown(): Response {
  return Response.json(
    {
      errors: [
        {
          message: 'The server is shutting down, retry later',
          extensions: { code: GraphQLErrorCode.ServiceUnavailable },
        },
      ],
    },
    { status: 503 },
  )
}

/**
 * Yoga's `maskError`: the errors of the engine (masked already) and the `GraphQLError`s thrown on
 * purpose (by Yoga or a plugin, with a code) are kept; any other error, thrown outside the engine
 * (an Envelop plugin's hook, Yoga itself), is logged and masked like the engine masks it
 * (`Unexpected error.`, its message with `exposeErrors`). Yoga then answers 500 for a request error.
 */
function outsideErrors(expose: boolean, logger: CoreLogger): (error: unknown, message: string) => Error {
  return (error, message) => {
    if (isOriginalGraphQLError(error)) return error
    logger.error('GraphQL: an error was thrown outside the engine (by Yoga or an Envelop plugin)', { err: error })
    const original = error instanceof Error ? error : new Error(String(error))
    return new GraphQLError(expose ? original.message : message, {
      originalError: original,
      extensions: { code: GraphQLErrorCode.InternalServerError },
    })
  }
}

/** A `GraphQLError` that wraps no other error: the engine's, or thrown on purpose. */
function isOriginalGraphQLError(error: unknown): error is GraphQLError {
  if (!(error instanceof GraphQLError)) return false
  const original = error.originalError
  return original === undefined || original === null || isOriginalGraphQLError(original)
}

function getNotAllowed(): Response {
  return Response.json(
    {
      errors: [
        { message: 'GraphQL operations are sent with POST on this endpoint', extensions: { code: 'BAD_REQUEST' } },
      ],
    },
    { status: 405, headers: { allow: 'POST' } },
  )
}

/** Envelop's onExecute payload (the part the driver reads). */
interface ExecutePayload {
  readonly executeFn: unknown
  readonly context: unknown
  setExecuteFn(fn: (args: ExecutionArgs) => unknown): void
}

interface SubscribePayload {
  readonly subscribeFn: unknown
  readonly context: unknown
  setSubscribeFn(fn: (args: ExecutionArgs) => unknown): void
}

interface ResultPayload {
  readonly result: unknown
  setResult(result: ExecutionResult): void
}

/**
 * The Envelop plugins of the engine: one installed before the application's plugins, which makes
 * the engine Yoga's `parse`, `validate`, `execute` and `subscribe` (Envelop's `useEngine`), and a
 * guard installed after them, which refuses an operation that a plugin executed elsewhere
 * (`useGraphQlJit`): its resolvers would not get the `GraphQLContext`. Plugins wrapping the
 * execution (`useResponseCache`) keep working: they call the engine (on a cache miss only).
 */
function engineFunctions(engine: GraphQLEngine, logger: CoreLogger): { plugin: YogaPlugin; guard: YogaPlugin } {
  const parse = engine.parse
  const validate = (schema: GraphQLSchema, document: DocumentNode, rules?: readonly ValidationRule[]) =>
    engine.validate(schema, document, rules)
  // marks the contexts the engine ran, once a plugin wrapped or replaced the execution
  let watching = false
  const ran = new WeakSet<object>()
  const execute = (args: ExecutionArgs): unknown => {
    if (watching) mark(ran, args.contextValue)
    return engine.execute(args)
  }
  const subscribe = (args: ExecutionArgs): unknown => {
    if (watching) mark(ran, args.contextValue)
    return engine.subscribe(args, SSE)
  }
  let reported = false
  const bypassed = (): ExecutionResult => {
    const error = invalid(
      'GraphQLPlugin: a Yoga plugin executed the operation instead of the Znight engine (useGraphQlJit?)',
      ['Remove the plugin: resolvers, guards and loaders only run on the engine'],
    )
    if (!reported) {
      reported = true
      logger.error(error.message, { error })
    }
    return { errors: [new GraphQLError(error.message, { extensions: { code: 'INTERNAL_SERVER_ERROR' } })] }
  }
  const plugin = {
    onParse: ({ setParseFn }: { setParseFn(fn: unknown): void }) => setParseFn(parse),
    onValidate: ({ setValidationFn }: { setValidationFn(fn: unknown): void }) => setValidationFn(validate),
    onExecute: ({ setExecuteFn }: ExecutePayload) => setExecuteFn(execute),
    onSubscribe: ({ setSubscribeFn }: SubscribePayload) => setSubscribeFn(subscribe),
  }
  const guard = {
    onExecute: ({ executeFn, context }: ExecutePayload) => {
      if (executeFn === execute) return undefined
      watching = true
      return {
        onExecuteDone: ({ setResult }: ResultPayload) => {
          if (!ran.has(context as object)) setResult(bypassed())
        },
      }
    },
    onSubscribe: ({ subscribeFn, context }: SubscribePayload) => {
      if (subscribeFn === subscribe) return undefined
      watching = true
      return {
        onSubscribeResult: ({ setResult }: ResultPayload) => {
          if (!ran.has(context as object)) setResult(bypassed())
        },
      }
    },
  }
  return { plugin: plugin as YogaPlugin, guard: guard as YogaPlugin }
}

function mark(ran: WeakSet<object>, context: unknown): void {
  if (context !== null && typeof context === 'object') ran.add(context)
}

function notStarted(): ZnightError {
  return new ZnightError(ErrorCode.LifecycleFailed, 'The Yoga driver is not started yet', {
    hints: ['GraphQLPlugin starts its driver in onBootstrap'],
  })
}

function invalid(message: string, hints: readonly string[]): ZnightError {
  return new ZnightError(ErrorCode.InvalidGraphQLSetup, message, { hints: [...hints] })
}
