/**
 * The gateway semantics of a connection (RFC 0003 §8.4 step 3, §5.8): decoding, `$ping`, handler
 * selection, message guards, `invoke` bounded by the handler timeout, replies and error mapping.
 * The plugin builds one {@link GatewayDispatcher} per gateway and gives it to its connections.
 */
import type { ConnectionDriver, WsCloseInfo, WsConnectionImpl } from './connection.ts'
import type { WsGuard, WsMessageContext } from './context.ts'
import type { MessageId, WireError } from './envelope.ts'
import type { GatewayDefinition, WsHandlerDefinition } from './metadata.ts'

import { HttpException } from '@znight/http'

import { decodeFrame, encodeErrorEvent, encodeErrorReply, encodeReply, isFailure } from './envelope.ts'
import { codeOfStatus, WsCloseCode, WsErrorCode, WsException, WsValidationException } from './exceptions.ts'

/** A handler with its resolved guards and effective metadata. */
export interface HandlerPlan {
  readonly definition: WsHandlerDefinition
  /** Plugin, gateway, then method guards. */
  readonly guards: readonly WsGuard[]
  /** Gateway meta merged with the method's (nearest wins). */
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
}

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

  constructor(options: DispatcherOptions) {
    this.#options = options
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

  rateLimited(conn: WsConnectionImpl, frame: string | Uint8Array): void {
    if (this.raw) return
    const decoded = decodeFrame(frame)
    const id = decoded.id
    const event = isFailure(decoded) ? undefined : decoded.event
    this.#fail(conn, id, event, { code: WsErrorCode.RateLimited, message: 'Too many messages' })
  }

  async dispatch(conn: WsConnectionImpl, frame: string | Uint8Array, binary: boolean): Promise<void> {
    const receivedAt = performance.now()
    let event: string | undefined
    let id: MessageId | undefined
    let data: unknown = frame
    if (!this.raw) {
      const decoded = decodeFrame(frame)
      if (isFailure(decoded)) {
        this.#fail(conn, decoded.id, undefined, { code: decoded.error, message: decoded.message })
        return
      }
      ;({ event, id, data } = decoded)
      if (event === '$ping') {
        if (id !== undefined) conn.sendFrame(encodeReply(id, { t: Date.now() }))
        return
      }
    }
    const plan = (event === undefined ? undefined : this.#byEvent.get(event)) ?? this.#fallback
    if (plan === undefined) {
      this.#fail(conn, id, event, { code: WsErrorCode.UnknownEvent, message: `Unknown event "${event}"` })
      return
    }
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
        handler: plan.definition.method,
        event,
        meta: plan.meta,
      },
    }
    try {
      const result = await this.#bounded(this.#run(plan, conn, ctx), abort)
      if (id !== undefined && conn.readyState === 'open') conn.sendFrame(encodeReply(id, result))
    } catch (error) {
      if (!isExpected(error)) this.#options.logError(`Handler ${plan.definition.method} failed`, error, conn)
      if (this.raw) {
        if (error instanceof WsException && error.close !== undefined) conn.close(error.close, error.message)
        return
      }
      this.#fail(conn, id, event, toWireError(error, this.#options.exposeErrors))
      if (error instanceof WsException && error.close !== undefined) conn.close(error.close, error.message)
    } finally {
      conn.signal.removeEventListener('abort', onClose)
    }
  }

  async #run(plan: HandlerPlan, conn: WsConnectionImpl, ctx: WsMessageContext): Promise<unknown> {
    for (const guard of plan.guards) {
      if (!(await guard.canActivate(ctx))) throw new WsException(WsErrorCode.Forbidden, 'Forbidden')
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
    conn.sendFrame(id === undefined ? encodeErrorEvent(event, error) : encodeErrorReply(id, error))
  }
}
