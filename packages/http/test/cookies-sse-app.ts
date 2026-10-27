/**
 * Sample application of the cookie and SSE tests (RFC 0006 §10.3), shared by the adapter matrix
 * (`cookies-adapters.test.ts`, `sse-adapters.test.ts`) and the Node.js / Bun fixture
 * (`fixtures/cookies-sse-check.ts`). The metadata is hand-written like the compiler output.
 */
import type { ZnightMetadata } from '@znight/core'
import type { CanActivate, HttpContext, HttpPluginOptions, SseEvent } from '../src/index.ts'

import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'

import {
  coerce,
  EventChannel,
  HttpResponse,
  NotFoundException,
  RequestAbortedError,
  UnauthorizedException,
  validate,
} from '../src/index.ts'
import { controller, metadata, provider, route, t } from './helpers.ts'

/** Signing secrets: the current one first, then the previous one (rotation). */
export const SECRETS: readonly string[] = ['current-secret-current-secret-0001', 'previous-secret-previous-secret-01']

export const ThemeCookie = z.enum(['light', 'dark']).catch('light')

// -------------------------------------------------------------------------------------------------
// Cookies
// -------------------------------------------------------------------------------------------------

export class PrefsController {
  read(theme: 'light' | 'dark', visits = 0): { theme: string; visits: number } {
    return { theme, visits }
  }
  setTheme(ctx: HttpContext): HttpResponse {
    ctx.setCookie('theme', 'dark', { maxAge: 365 * 86_400, httpOnly: false })
    return HttpResponse.noContent()
  }
  all(cookies: Record<string, string>): Record<string, string> {
    return { ...cookies }
  }
  count(n: number): { n: number } {
    return { n }
  }
}

export class ClearingGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    ctx.clearCookie('sid')
    throw new UnauthorizedException()
  }
}

export class AuthController {
  login(): HttpResponse {
    return HttpResponse.ok({ id: 'u-1' }).withCookie('__Host-uid', 'u-1', { signed: true, maxAge: 8 * 3600 })
  }
  logout(ctx: HttpContext): HttpResponse {
    ctx.clearCookie('__Host-uid')
    return HttpResponse.noContent()
  }
  me(uid: string): { uid: string } {
    return { uid }
  }
  guarded(): string {
    return 'never'
  }
  redirect(ctx: HttpContext): HttpResponse {
    ctx.setCookie('flash', 'saved')
    return HttpResponse.redirect('/prefs')
  }
  merge(ctx: HttpContext): HttpResponse {
    ctx.appendHeader('set-cookie', 'raw=1; Path=/')
    ctx.setCookie('a', 'ctx')
    ctx.setCookie('c', 'kept')
    return HttpResponse.ok('merged').withCookie('a', 'response').withCookie('b', 'two words')
  }
  web(ctx: HttpContext): Response {
    ctx.setCookie('jar', '1')
    // explicit: Node.js and Bun differ on the implicit content type of a string body
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' })
    headers.append('set-cookie', 'web=1; Path=/')
    headers.append('set-cookie', 'web2=2; Expires=Wed, 02 Jan 2030 03:04:05 GMT')
    return new Response('web', { headers })
  }
  invalid(ctx: HttpContext): HttpResponse {
    ctx.setCookie('kept', '1')
    // valid on its own, invalid with the secure default turned off: detected when serialised
    return HttpResponse.ok('x').withCookie('__Host-x', 'v', { secure: false })
  }
  echo(ctx: HttpContext): { header: string | undefined; cookies: Record<string, string> } {
    return { header: ctx.headers['cookie'], cookies: { ...ctx.cookies } }
  }
}

// -------------------------------------------------------------------------------------------------
// Server-Sent Events
// -------------------------------------------------------------------------------------------------

/** What the event sources observed (reset by {@link resetSseState}). */
export const sseState: {
  generated: number
  finallyRan: number
  signals: string[]
  bodyRan: boolean
  disposed: number
  published: number
} = { generated: 0, finallyRan: 0, signals: [], bodyRan: false, disposed: 0, published: 0 }

/** The signal of the last `GET /events/wait` / `GET /events/quick` request. */
export const signalProbe: { signal: AbortSignal | undefined } = { signal: undefined }

/** Releases the pending `GET /events/hold` request. */
export const holdGate: { release: () => void } = { release: () => undefined }

export function resetSseState(): void {
  Object.assign(sseState, { generated: 0, finallyRan: 0, signals: [], bodyRan: false, disposed: 0, published: 0 })
}

/** Records the abort reason of a request signal. */
function watch(signal: AbortSignal): void {
  signal.addEventListener('abort', () => {
    const reason = signal.reason
    sseState.signals.push(reason instanceof RequestAbortedError ? reason.kind : String(reason))
  })
}

/** Order events: a bounded channel per subscriber, resumable with Last-Event-ID. */
export class OrderHub {
  readonly #subscribers = new Set<EventChannel<SseEvent>>()
  readonly #history: { id: number; status: string }[] = [
    { id: 1, status: 'created' },
    { id: 2, status: 'paid' },
  ]

  subscribe(after: string | undefined, signal: AbortSignal, capacity = 256): EventChannel<SseEvent> {
    const channel = new EventChannel<SseEvent>({ capacity, overflow: 'close', signal })
    this.#subscribers.add(channel)
    channel.onClose(() => this.#subscribers.delete(channel))
    for (const entry of this.#history) {
      if (after === undefined || entry.id > Number(after)) channel.push(toEvent(entry))
    }
    return channel
  }

  publish(status: string): void {
    const entry = { id: this.#history.length + 1, status }
    this.#history.push(entry)
    sseState.published++
    for (const channel of this.#subscribers) channel.push(toEvent(entry))
  }

  get subscribers(): number {
    return this.#subscribers.size
  }
}

function toEvent(entry: { id: number; status: string }): SseEvent {
  return { id: entry.id, event: 'status', data: { status: entry.status } }
}

/** A request-scoped resource (disposed when the stream ends). */
export class StreamResource {
  [Symbol.dispose](): void {
    sseState.disposed++
  }
}

export class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException()
  }
}

export class EventsController {
  readonly #hub: OrderHub
  constructor(hub: OrderHub) {
    this.#hub = hub
  }

  /** Pre-flight checks in an async method, then the source. */
  async orders(
    id: string,
    lastEventId: string | undefined,
    ctx: HttpContext,
  ): Promise<AsyncIterable<SseEvent> | HttpResponse> {
    await Promise.resolve()
    if (id === 'missing') throw new NotFoundException(`Order ${id} not found`)
    if (id === 'closed') return HttpResponse.noContent()
    watch(ctx.signal)
    return this.#hub.subscribe(lastEventId, ctx.signal)
  }

  /** An async generator honouring the signal. */
  async *clock(ctx: HttpContext): AsyncGenerator<SseEvent> {
    sseState.bodyRan = true
    watch(ctx.signal)
    try {
      while (!ctx.signal.aborted) {
        sseState.generated++
        yield { event: 'tick', data: { n: sseState.generated } }
        await sleep(20, undefined, { signal: ctx.signal }).catch(() => undefined)
      }
    } finally {
      sseState.finallyRan++
    }
  }

  /** Framing of every kind of event. */
  framing(): SseEvent[] {
    return [
      { id: 41, event: 'status', data: { orderId: 'o-1', status: 'paid' } },
      { data: 'line 1\nline 2' },
      { comment: 'note' },
      { event: 'done' },
      { data: ' leading space' },
    ]
  }

  /** POST streaming with HttpResponse.sse() (200, not 201), plus a cookie and a header. */
  assistant(prompt: string, ctx: HttpContext): HttpResponse {
    ctx.setCookie('conversation', 'c-1')
    function* tokens(): Generator<SseEvent> {
      for (const token of prompt.split(' ')) yield { event: 'token', data: token }
      yield { event: 'complete', data: '' }
    }
    return HttpResponse.sse(tokens()).withHeader('x-model', 'test').withCookie('turn', '1')
  }

  /** Quiet until the client leaves. */
  async *quiet(ctx: HttpContext): AsyncGenerator<SseEvent> {
    watch(ctx.signal)
    await new Promise(resolve => ctx.signal.addEventListener('abort', resolve))
    yield { data: 'never sent' }
  }

  /** Ignores its signal: released after the bound. */
  async *blocked(): AsyncGenerator<SseEvent> {
    try {
      yield { data: 'first' }
      await new Promise(() => undefined)
    } finally {
      sseState.finallyRan++
    }
  }

  /** Fails mid-stream (a sync generator: an Iterable source). */
  *failing(): Generator<SseEvent> {
    yield { data: 'before' }
    throw new Error('upstream down')
  }

  /** maxDuration: yields a final event when its signal aborts. */
  async *expiring(ctx: HttpContext): AsyncGenerator<SseEvent> {
    watch(ctx.signal)
    yield { data: 'start' }
    await new Promise(resolve => ctx.signal.addEventListener('abort', resolve))
    yield { event: 'bye', data: (ctx.signal.reason as RequestAbortedError).kind }
  }

  /** An endless, fast source of large events (backpressure). */
  *firehose(ctx: HttpContext): Generator<SseEvent> {
    watch(ctx.signal)
    const data = 'x'.repeat(16 * 1024)
    try {
      for (;;) {
        sseState.generated++
        yield { data }
      }
    } finally {
      sseState.finallyRan++
    }
  }

  /** A slow subscriber of a small channel: closed on overflow. */
  overflow(ctx: HttpContext): EventChannel<SseEvent> {
    return this.#hub.subscribe('999', ctx.signal, 2)
  }

  guarded(): SseEvent[] {
    return [{ data: 'never' }]
  }

  bad(): unknown {
    return undefined
  }

  /** A plain route waiting for its client to leave (ctx.signal on any route). */
  async wait(ctx: HttpContext): Promise<string> {
    signalProbe.signal = ctx.signal
    watch(ctx.signal)
    await new Promise(resolve => {
      ctx.signal.addEventListener('abort', resolve)
      setTimeout(resolve, 3_000)
    })
    return 'done'
  }

  /** A plain route completing at once: its signal never aborts afterwards. */
  quick(ctx: HttpContext): string {
    signalProbe.signal = ctx.signal
    return 'quick'
  }

  /** A plain request kept in flight until {@link holdGate} releases it (holds a graceful drain). */
  async hold(): Promise<string> {
    await new Promise<void>(resolve => {
      holdGate.release = resolve
    })
    return 'released'
  }
}

/** A request-scoped controller holding a request-scoped resource while its stream runs. */
export class ScopedEventsController {
  readonly #resource: StreamResource
  constructor(resource: StreamResource) {
    this.#resource = resource
  }

  async *stream(ctx: HttpContext): AsyncGenerator<SseEvent> {
    watch(ctx.signal)
    try {
      for (;;) {
        sseState.generated++
        yield { data: sseState.disposed === 0 && this.#resource instanceof StreamResource ? 'alive' : 'disposed' }
        await sleep(10, undefined, { signal: ctx.signal })
      }
    } finally {
      sseState.finallyRan++
    }
  }
}

const cookieLabel = (name: string): string => `cookie "${name}"`

/** Metadata of the application (what the compiler generates for the controllers above). */
export function cookiesSseMetadata(): ZnightMetadata {
  return metadata(
    {
      [t('PrefsController')]: provider(PrefsController),
      [t('AuthController')]: provider(AuthController),
      [t('ClearingGuard')]: provider(ClearingGuard),
      [t('DenyGuard')]: provider(DenyGuard),
      [t('OrderHub')]: provider(OrderHub),
      [t('StreamResource')]: provider(StreamResource, [], 'request'),
      [t('EventsController')]: provider(EventsController, [t('OrderHub')]),
      [t('ScopedEventsController')]: provider(ScopedEventsController, [t('StreamResource')], 'request'),
    },
    [
      controller(t('PrefsController'), '/prefs', [
        route(
          'read',
          '/',
          async (c: PrefsController, ctx) =>
            c.read(
              await validate(ThemeCookie, ctx.cookies['theme'], cookieLabel('theme')),
              coerce.optional(ctx.cookies['visits'], cookieLabel('visits'), coerce.number),
            ),
          {
            params: [
              { index: 0, source: 'cookie', name: 'theme', schema: true },
              { index: 1, source: 'cookie', name: 'visits', type: 'number', optional: true },
            ],
          },
        ),
        route('setTheme', '/theme', (c: PrefsController, ctx) => c.setTheme(ctx), {
          method: 'POST',
          params: [{ index: 0, source: 'context' }],
        }),
        route('all', '/all', (c: PrefsController, ctx) => c.all(ctx.cookies as never), {
          params: [{ index: 0, source: 'cookie' }],
        }),
        route(
          'count',
          '/count',
          (c: PrefsController, ctx) => c.count(coerce.number(ctx.cookies['n'], cookieLabel('n'))),
          {
            params: [{ index: 0, source: 'cookie', name: 'n', type: 'number' }],
          },
        ),
      ]),
      controller(t('AuthController'), '/auth', [
        route('login', '/login', (c: AuthController) => c.login(), { method: 'POST' }),
        route('logout', '/logout', (c: AuthController, ctx) => c.logout(ctx), { method: 'POST' }),
        route(
          'me',
          '/me',
          (c: AuthController, ctx) => c.me(coerce.string(ctx.signedCookie('__Host-uid'), cookieLabel('__Host-uid'))),
          { params: [{ index: 0, source: 'signedCookie', name: '__Host-uid', type: 'string' }] },
        ),
        route('guarded', '/guarded', (c: AuthController) => c.guarded(), { guards: [t('ClearingGuard')] }),
        route('redirect', '/redirect', (c: AuthController, ctx) => c.redirect(ctx)),
        route('merge', '/merge', (c: AuthController, ctx) => c.merge(ctx)),
        route('web', '/web', (c: AuthController, ctx) => c.web(ctx)),
        route('invalid', '/invalid', (c: AuthController, ctx) => c.invalid(ctx)),
        route('echo', '/echo', (c: AuthController, ctx) => c.echo(ctx)),
      ]),
      controller(t('EventsController'), '/events', [
        route(
          'orders',
          '/orders/:id',
          (c: EventsController, ctx) =>
            c.orders(
              coerce.string(ctx.params['id'], 'param "id"'),
              coerce.optional(ctx.headers['last-event-id'], 'header "last-event-id"', coerce.string),
              ctx,
            ),
          { sse: { retry: 5_000 } },
        ),
        route('clock', '/clock', (c: EventsController, ctx) => c.clock(ctx), { sse: { heartbeat: 0 } }),
        route('framing', '/framing', (c: EventsController) => c.framing(), { sse: {} }),
        route(
          'assistant',
          '/assistant',
          async (c: EventsController, ctx) =>
            c.assistant(await validate(z.string(), await ctx.parseBody(), 'body'), ctx),
          { method: 'POST', params: [{ index: 0, source: 'body', schema: true }] },
        ),
        route('quiet', '/quiet', (c: EventsController, ctx) => c.quiet(ctx), { sse: { heartbeat: 1_000 } }),
        route('blocked', '/blocked', (c: EventsController) => c.blocked(), { sse: {} }),
        route('failing', '/failing', (c: EventsController) => c.failing(), { sse: {} }),
        route('expiring', '/expiring', (c: EventsController, ctx) => c.expiring(ctx), {
          sse: { maxDuration: 1_000, retry: 100 },
        }),
        route('firehose', '/firehose', (c: EventsController, ctx) => c.firehose(ctx), { sse: { heartbeat: 0 } }),
        route('overflow', '/overflow', (c: EventsController, ctx) => c.overflow(ctx), { sse: { heartbeat: 0 } }),
        route('guarded', '/guarded', (c: EventsController) => c.guarded(), { sse: {}, guards: [t('DenyGuard')] }),
        route('bad', '/bad', (c: EventsController) => c.bad(), { sse: {} }),
        route('hold', '/hold', (c: EventsController) => c.hold()),
        route('wait', '/wait', (c: EventsController, ctx) => c.wait(ctx)),
        route('quick', '/quick', (c: EventsController, ctx) => c.quick(ctx)),
        route('status', '/status', () => HttpResponse.sse([{ data: 'accepted' }]), { method: 'POST', status: 202 }),
      ]),
      controller(t('ScopedEventsController'), '/scoped', [
        route('stream', '/', (c: ScopedEventsController, ctx) => c.stream(ctx), { sse: { heartbeat: 0 } }),
      ]),
    ],
  )
}

/** Plugin options of the application. */
export function cookiesSseOptions(): HttpPluginOptions {
  return { cookies: { secrets: SECRETS }, sse: { shutdownGraceMs: 300 }, drainTimeoutMs: 3_000 }
}
