/**
 * The gateway semantics of a connection (RFC 0003 §8.4 step 3, §5.8): decoding, `$ping`, handler
 * selection, message guards, `invoke` bounded by the handler timeout, replies and error mapping.
 * The plugin builds one {@link GatewayDispatcher} per gateway and gives it to its connections.
 */
import type { Hooks, WebSocketMessageEvent, WebSocketMessageOutcome } from '@znight/core'
import type { ConnectionDriver, WsCloseInfo, WsConnectionImpl } from './connection.ts'
import type { WsExceptionMapper, WsGuard, WsMessageContext } from './context.ts'
import type { InboundFailure, InboundMessage, MessageId, OutboundMessage, WireError, WsCodec } from './envelope.ts'
import type { GatewayDefinition, WsHandlerDefinition } from './metadata.ts'

import { HttpException } from '@znight/http'

import { isFailure, jsonCodec } from './envelope.ts'
import { codeOfStatus, WsCloseCode, WsErrorCode, WsException, WsValidationException } from './exceptions.ts'

/** A handler with its resolved guards and effective metadata. */
export interface HandlerPlan {
  readonly definition: WsHandlerDefinition
  /** Plugin, gateway, then method guards. */
  readonly guards: readonly WsGuard[]
  /** The gateway entries of the groups the method does not decide, then the method entries. */
  readonly meta: Readonly<Record<string, unknown>>
}

/** What a dispatcher needs from the plugin. */
export interface DispatcherOptions {
  readonly definition: GatewayDefinition
  /** Gateway path, prefix included. */
  readonly path: string
  readonly handlers: readonly HandlerPlan[]
  /** The gateway instance of a connection (singleton, or the request-scoped one of its handshake). */
  readonly instance: (conn: WsConnectionImpl) => object | Promise<object>
  readonly handlerTimeoutMs: number
  readonly exposeErrors: boolean
  /** Logs an unexpected error (handler, guard, lifecycle). */
  readonly logError: (message: string, error: unknown, conn: WsConnectionImpl) => void
  /** Once a connection is fully closed. */
  readonly closed: (conn: WsConnectionImpl, info: WsCloseInfo) => void
  /** The `websocket:message` hook: run when it has wrappers, emitted when it has listeners. */
  readonly hooks?: Hooks
  /** Display name of the gateway (hook events). */
  readonly name?: string
  /** Plugin `exceptionMappers`, in order. */
  readonly mappers?: readonly WsExceptionMapper[]
  /** The codec of `events` gateways. Default: {@link jsonCodec}. */
  readonly codec?: WsCodec
  /**
   * Development aid: called once per handler whose result was ignored (a message without `id`
   * answered by a value). Omitted in production.
   */
  readonly ignoredResult?: (handler: string, event: string | undefined) => void
}

const MESSAGE_HOOK = 'websocket:message'

/** How a message ended (the `websocket:message` outcome and error). */
interface Settled {
  readonly outcome: WebSocketMessageOutcome
  readonly error?: unknown
}

const OK: Settled = Object.freeze({ outcome: 'ok' })

class TimeoutError extends Error {}

/** Converts what a handler or a guard threw to a wire error. */
export function toWireError(error: unknown, exposeErrors: boolean): WireError {
  if (error instanceof WsException) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }
  if (error instanceof HttpException) {
    const code = codeOfStatus(error.status)
    const message = code === WsErrorCode.Internal && !exposeErrors ? 'Internal error' : error.message
    return { code, message, ...(error.details === undefined ? {} : { details: error.details }) }
  }
  if (error instanceof TimeoutError) return { code: WsErrorCode.Timeout, message: 'The handler timed out' }
  const message = exposeErrors && error instanceof Error ? error.message : 'Internal error'
  return { code: WsErrorCode.Internal, message }
}

function isForbidden(error: unknown): boolean {
  if (error instanceof WsException)
    return error.code === WsErrorCode.Forbidden || error.code === WsErrorCode.Unauthorized
  return error instanceof HttpException && (error.status === 401 || error.status === 403)
}

function isExpected(error: unknown): boolean {
  if (error instanceof WsException || error instanceof TimeoutError) return true
  return error instanceof HttpException && error.status < 500
}

/** The close code of an `@OnConnect` failure (§5.8). */
export function connectFailureCode(error: unknown): { readonly code: number; readonly reason: string } {
  if (error instanceof WsValidationException) return { code: 4400, reason: error.message }
  if (error instanceof WsException) return { code: error.close ?? WsCloseCode.PolicyViolation, reason: error.message }
  if (error instanceof HttpException) return { code: 4000 + error.status, reason: error.message }
  return { code: WsCloseCode.InternalError, reason: 'Internal error' }
}

/** One gateway's message pipeline, shared by its connections. */
export class GatewayDispatcher implements ConnectionDriver {
  readonly #options: DispatcherOptions
  readonly #byEvent = new Map<string, HandlerPlan>()
  readonly #fallback: HandlerPlan | undefined
  readonly #codec: WsCodec
  readonly #ignored = new Set<string>()

  constructor(options: DispatcherOptions) {
    this.#options = options
    this.#codec = options.codec ?? jsonCodec
    let fallback: HandlerPlan | undefined
    for (const plan of options.handlers) {
      if (plan.definition.event === undefined) fallback = plan
      else this.#byEvent.set(plan.definition.event, plan)
    }
    this.#fallback = fallback
  }

  get raw(): boolean {
    return this.#options.definition.protocol === 'raw'
  }

  async connect(conn: WsConnectionImpl): Promise<void> {
    const lifecycle = this.#options.definition.onConnect
    if (lifecycle === undefined) return
    const gateway = await this.#options.instance(conn)
    await this.#bounded(Promise.resolve(lifecycle.invoke(gateway, conn)), undefined)
  }

  connectFailure(error: unknown): { readonly code: number; readonly reason: string } {
    return connectFailureCode(error)
  }

  async disconnect(conn: WsConnectionImpl): Promise<void> {
    const lifecycle = this.#options.definition.onDisconnect
    if (lifecycle === undefined) return
    try {
      await lifecycle.invoke(await this.#options.instance(conn), conn)
    } catch (error) {
      this.#options.logError(`@OnDisconnect ${lifecycle.method} failed`, error, conn)
    }
  }

  closed(conn: WsConnectionImpl, info: WsCloseInfo): void {
    this.#options.closed(conn, info)
  }

  rateLimited(conn: WsConnectionImpl, frame: string | Uint8Array, binary: boolean): void {
    if (this.raw) return
    const decoded = this.#decode(conn, frame, binary)
    const id = decoded.id
    const event = isFailure(decoded) ? undefined : decoded.event
    this.#fail(conn, id, event, { code: WsErrorCode.RateLimited, message: 'Too many messages' })
  }

  async dispatch(conn: WsConnectionImpl, frame: string | Uint8Array, binary: boolean): Promise<void> {
    const receivedAt = performance.now()
    let event: string | undefined
    let id: MessageId | undefined
    let data: unknown = frame
    let failure: WireError | undefined
    if (!this.raw) {
      const decoded = this.#decode(conn, frame, binary)
      if (isFailure(decoded)) {
        id = decoded.id
        failure = { code: decoded.error, message: decoded.message }
      } else {
        ;({ event, id, data } = decoded)
        if (event === '$ping') {
          if (id !== undefined) this.#send(conn, { kind: 'reply', id, data: { t: Date.now() } })
          return
        }
      }
    }
    const plan =
      failure === undefined
        ? ((event === undefined ? undefined : this.#byEvent.get(event)) ?? this.#fallback)
        : undefined
    const abort = new AbortController()
    const onClose = () => abort.abort(conn.signal.reason)
    conn.signal.addEventListener('abort', onClose, { once: true })
    const ctx: WsMessageContext = {
      connection: conn,
      event,
      id,
      data,
      binary,
      bytes: typeof frame === 'string' ? frame.length : frame.byteLength,
      receivedAt,
      signal: abort.signal,
      state: new Map(),
      route: {
        path: this.#options.path,
        gateway: this.#options.definition.token,
        handler: plan?.definition.method,
        event,
        meta: plan?.meta ?? this.#options.definition.meta,
      },
    }
    try {
      const hooks = this.#options.hooks
      if (hooks === undefined || (!hooks.hasWrappers(MESSAGE_HOOK) && !hooks.hasListeners(MESSAGE_HOOK))) {
        await this.#handle(plan, conn, ctx, failure, abort)
        return
      }
      const hookEvent: WebSocketMessageEvent = {
        gateway: this.#options.name ?? String(this.#options.definition.token),
        path: this.#options.path,
        event,
        handler: plan?.definition.method,
        connectionId: conn.id,
        requestId: conn.requestId,
        bytes: ctx.bytes,
        context: ctx,
        startTime: receivedAt,
      }
      try {
        await hooks.run(MESSAGE_HOOK, hookEvent, async () => {
          const settled = await this.#handle(plan, conn, ctx, failure, abort)
          hookEvent.outcome = settled.outcome
          if (settled.error !== undefined) hookEvent.error = settled.error
        })
      } catch (error) {
        this.#options.logError('A "websocket:message" hook wrapper failed', error, conn)
      }
      if (hooks.hasListeners(MESSAGE_HOOK)) hooks.emit(MESSAGE_HOOK, hookEvent)
    } finally {
      conn.signal.removeEventListener('abort', onClose)
    }
  }

  /** Guards, handler, reply and error mapping of one message. Never rejects. */
  async #handle(
    plan: HandlerPlan | undefined,
    conn: WsConnectionImpl,
    ctx: WsMessageContext,
    failure: WireError | undefined,
    abort: AbortController,
  ): Promise<Settled> {
    if (failure !== undefined) {
      this.#fail(conn, ctx.id, undefined, failure)
      return { outcome: 'error', error: new WsException(failure.code, failure.message) }
    }
    if (plan === undefined) {
      this.#fail(conn, ctx.id, ctx.event, {
        code: WsErrorCode.UnknownEvent,
        message: `Unknown event "${ctx.event}"`,
      })
      return { outcome: 'unhandled' }
    }
    let rejected = false
    try {
      const result = await this.#bounded(
        this.#run(plan, conn, ctx, () => {
          rejected = true
        }),
        abort,
      )
      if (ctx.id !== undefined && conn.readyState === 'open') {
        this.#send(conn, { kind: 'reply', id: ctx.id, data: result })
      } else if (ctx.id === undefined && result !== undefined && !this.raw) {
        this.#ignoredResult(plan.definition.method, ctx.event)
      }
      return OK
    } catch (thrown) {
      const error = await this.#map(thrown, ctx, conn)
      if (!isExpected(error)) this.#options.logError(`Handler ${plan.definition.method} failed`, error, conn)
      if (!this.raw) this.#fail(conn, ctx.id, ctx.event, toWireError(error, this.#options.exposeErrors))
      if (error instanceof WsException && error.close !== undefined) conn.close(error.close, error.message)
      let outcome: WebSocketMessageOutcome = 'error'
      if (thrown instanceof TimeoutError) outcome = 'timeout'
      else if (rejected && isForbidden(error)) outcome = 'rejected'
      return { outcome, error: thrown }
    }
  }

  #ignoredResult(method: string, event: string | undefined): void {
    const report = this.#options.ignoredResult
    if (report === undefined || this.#ignored.has(method)) return
    this.#ignored.add(method)
    report(method, event)
  }

  /** Runs the plugin exception mappers, in order: the first `WsException` wins. */
  async #map(error: unknown, ctx: WsMessageContext, conn: WsConnectionImpl): Promise<unknown> {
    const mappers = this.#options.mappers
    if (mappers === undefined || mappers.length === 0 || error instanceof TimeoutError) return error
    for (const mapper of mappers) {
      try {
        const mapped = await mapper.map(error, ctx)
        if (mapped !== undefined) return mapped
      } catch (failure) {
        this.#options.logError('A WebSocket exception mapper failed', failure, conn)
        return failure
      }
    }
    return error
  }

  async #run(plan: HandlerPlan, conn: WsConnectionImpl, ctx: WsMessageContext, refused: () => void): Promise<unknown> {
    for (const guard of plan.guards) {
      let allowed: boolean
      try {
        allowed = (await guard.canHandle(ctx)) === true
      } catch (error) {
        refused()
        throw error
      }
      if (!allowed) {
        refused()
        throw new WsException(WsErrorCode.Forbidden, 'Forbidden')
      }
    }
    const gateway = await this.#options.instance(conn)
    return await plan.definition.invoke(gateway, ctx)
  }

  /** Races a task with the handler timeout; aborts `abort` on timeout. */
  #bounded<T>(task: Promise<T>, abort: AbortController | undefined): Promise<T> {
    const ms = this.#options.handlerTimeoutMs
    if (!Number.isFinite(ms)) return task
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new TimeoutError('The handler timed out')
        abort?.abort(error)
        reject(error)
      }, ms)
    })
    task.catch(() => undefined)
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
  }

  #fail(conn: WsConnectionImpl, id: MessageId | undefined, event: string | undefined, error: WireError): void {
    if (this.raw || conn.readyState !== 'open') return
    this.#send(conn, { kind: 'error', id, event, error })
  }

  /**
   * Decodes with the codec. A codec that throws instead of returning a failure (a MessagePack
   * decoder on malformed input...) is a `BAD_FRAME`, logged: the rate-limit path runs in the
   * transport's message callback, where an exception would crash the process.
   */
  #decode(conn: WsConnectionImpl, frame: string | Uint8Array, binary: boolean): InboundMessage | InboundFailure {
    try {
      return this.#codec.decode(frame, binary)
    } catch (error) {
      this.#options.logError('The codec failed to decode a frame', error, conn)
      return { error: WsErrorCode.BadFrame, message: 'The frame could not be decoded', id: undefined }
    }
  }

  /** Encodes and sends a frame of the runtime (reply, error); an encoding failure is logged. */
  #send(conn: WsConnectionImpl, message: OutboundMessage): void {
    let frame: string | Uint8Array
    try {
      frame = this.#codec.encode(message)
    } catch (error) {
      this.#options.logError('The codec failed to encode a frame', error, conn)
      return
    }
    conn.sendFrame(frame)
  }
}
