/**
 * WebSocket upgrades on the adapters (RFC 0003 §8.2.3, internal): the upgrade capability of
 * `node:http` servers, the request of a handshake as an {@link AdapterRequest} (Node.js, Fetch,
 * in memory) and the raw HTTP refusal written on a socket.
 */
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AdapterReply, AdapterRequest } from '../adapter.ts'
import type { HeaderValue } from '../exceptions.ts'
import type { AdapterUpgrades, BunSocketHandlers, UpgradeHandlerOptions } from '../upgrade.ts'

import { statusText } from '../status.ts'
import { isWebSocketUpgrade } from '../upgrade.ts'
import { markUpgraded, normalizeNodeHeaders } from './node-io.ts'
import { concat } from './shared.ts'

const EMPTY = new Uint8Array(0)

/** A handshake has no body: Znight never reads one. */
const NO_BODY: Promise<Uint8Array> = Promise.resolve(EMPTY)

/** No listener to remove. */
const NOTHING = (): void => undefined

/** Calls `listener` on the next microtask, unless the returned function was called before. */
function callSoon(listener: () => void): () => void {
  let removed = false
  queueMicrotask(() => {
    if (!removed) listener()
  })
  return () => {
    removed = true
  }
}

/**
 * Calls `listener` once when `signal` aborts (on the next microtask when it already did); returns
 * the function removing it.
 */
function onSignalAbort(signal: AbortSignal | undefined, listener: () => void): () => void {
  if (signal === undefined) return NOTHING
  if (signal.aborted) return callSoon(listener)
  const aborted = (): void => listener()
  signal.addEventListener('abort', aborted, { once: true })
  return () => signal.removeEventListener('abort', aborted)
}

/**
 * Whether the client ended its side of `socket`: `readableEnded` only turns true once the buffered
 * bytes were read, the stream state knows as soon as the end arrived (Node.js and Bun keep it as
 * `_readableState.ended`).
 */
function ended(socket: Duplex): boolean {
  const state = (socket as { readonly _readableState?: { readonly ended?: unknown } })._readableState
  return socket.readableEnded || state?.ended === true
}

/** The `IncomingMessage` of a `node:http` upgrade as an {@link AdapterRequest}. */
class NodeUpgradeRequest implements AdapterRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly ip: string | undefined
  readonly remoteAddress: string | undefined
  readonly encrypted: boolean
  readonly raw: unknown
  readonly rawResponse: unknown

  constructor(request: IncomingMessage, socket: Duplex) {
    const peer = (socket as { readonly remoteAddress?: string }).remoteAddress ?? request.socket?.remoteAddress
    this.method = request.method ?? 'GET'
    this.url = request.url ?? '/'
    this.headers = normalizeNodeHeaders(request.headers)
    this.ip = peer
    this.remoteAddress = peer
    this.encrypted = (request.socket as { readonly encrypted?: unknown } | undefined)?.encrypted === true
    this.raw = request
    this.rawResponse = socket
  }

  readBody(): Promise<Uint8Array> {
    return NO_BODY
  }

  hasBody(): boolean {
    return false
  }

  /**
   * The client left during the handshake: the socket closed, or the client ended its side (a
   * `node:http` server allows half-open sockets, so a client's FIN alone never closes the socket).
   * Nothing reads the socket during the handshake, so a FIN after bytes the client sent past its
   * headers (a frame sent early) emits no `end` until they are read: `readable`, emitted at the end
   * of the stream whatever is buffered, catches it (and reads nothing). The plugin removes the
   * listeners once the transport took the socket (removing `readable` hands the socket back
   * unpaused to whoever reads it next): its later close is the connection's, not the handshake's.
   */
  onAbort(listener: () => void): () => void {
    const socket = this.rawResponse as Duplex
    if (socket.destroyed || ended(socket)) return callSoon(listener)
    let called = false
    const gone = (): void => {
      if (called) return
      called = true
      listener()
    }
    const readable = (): void => {
      if (ended(socket)) gone()
    }
    socket.once('end', gone)
    socket.once('close', gone)
    socket.on('readable', readable)
    return () => {
      socket.removeListener('end', gone)
      socket.removeListener('close', gone)
      socket.removeListener('readable', readable)
    }
  }
}

/** The Fetch `Request` of a `Bun.serve()` upgrade as an {@link AdapterRequest}. */
export class FetchUpgradeRequest implements AdapterRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly ip: string | undefined
  readonly remoteAddress: string | undefined
  readonly encrypted: boolean
  readonly raw: Request
  readonly rawResponse: unknown = undefined

  constructor(request: Request, url: string, headers: Record<string, string>, address: string | undefined) {
    this.method = request.method
    this.url = url
    this.headers = headers
    this.ip = address
    this.remoteAddress = address
    this.encrypted = request.url.startsWith('https:')
    this.raw = request
  }

  readBody(): Promise<Uint8Array> {
    return NO_BODY
  }

  hasBody(): boolean {
    return false
  }

  /**
   * `request.signal` aborted: `Bun.serve()` aborts it when the client closes its connection, during
   * the handshake and also once upgraded (when the WebSocket closes), hence the removal once the
   * transport took the connection.
   */
  onAbort(listener: () => void): () => void {
    return onSignalAbort(this.raw.signal, listener)
  }
}

/** An in-memory handshake (`HttpPlugin.upgradeInMemory()`) as an {@link AdapterRequest}. */
export class MemoryUpgradeRequest implements AdapterRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly ip = '127.0.0.1'
  readonly remoteAddress = '127.0.0.1'
  readonly encrypted = false
  readonly raw: unknown = undefined
  readonly rawResponse: unknown = undefined
  readonly #signal: AbortSignal | undefined

  /** `signal`: aborting it disconnects the client. */
  constructor(method: string, url: string, headers: Record<string, string>, signal?: AbortSignal) {
    this.method = method
    this.url = url
    this.headers = headers
    this.#signal = signal
  }

  readBody(): Promise<Uint8Array> {
    return NO_BODY
  }

  hasBody(): boolean {
    return false
  }

  /** The caller's `signal` aborted. */
  onAbort(listener: () => void): () => void {
    return onSignalAbort(this.#signal, listener)
  }
}

/** The bytes of a reply body (refusals are small: read whole). */
export async function replyBytes(reply: AdapterReply): Promise<Uint8Array> {
  const body = reply.body
  if (body === null) return EMPTY
  if (body instanceof Uint8Array) return body
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of body as ReadableStream<Uint8Array>) {
    chunks.push(chunk)
    size += chunk.byteLength
  }
  return concat(chunks, size)
}

/** Whether a header value can be written on a raw socket (no CR/LF injection). */
function safeHeader(value: string): boolean {
  return !/[\r\n]/.test(value)
}

/**
 * Writes a refused handshake as a raw HTTP/1.1 response on the upgrade socket, then ends it
 * (`connection: close`). Never throws.
 */
export async function writeRawRefusal(socket: Duplex, reply: AdapterReply): Promise<void> {
  try {
    const body = await replyBytes(reply)
    let head = `HTTP/1.1 ${reply.status} ${statusText(reply.status)}\r\n`
    const headers: Record<string, HeaderValue> = { ...reply.headers }
    headers['connection'] = 'close'
    headers['content-length'] = String(body.byteLength)
    for (const [name, value] of Object.entries(headers)) {
      for (const item of typeof value === 'string' ? [value] : value) {
        if (safeHeader(name) && safeHeader(item)) head += `${name}: ${item}\r\n`
      }
    }
    head += '\r\n'
    if (socket.destroyed) return
    socket.write(head)
    if (body.byteLength > 0) socket.write(body)
    socket.end()
    // a client that never closes its side: destroy after a short grace
    setTimeout(() => socket.destroy(), 1_000).unref?.()
  } catch {
    socket.destroy()
  }
}

/** The fallback reply when the pipeline failed (never expected). */
const FAILURE: AdapterReply = Object.freeze({ status: 500, headers: {}, body: null })

/**
 * The upgrade capability of an adapter built on a `node:http` server (RFC 0003 §8.2.3): upgrade
 * requests of the gateway paths are routed to the pipeline through `shouldUpgradeCallback`
 * (composed with the server's own) and an `'upgrade'` listener; other upgrade requests are left to
 * the server (its own listeners, or ordinary requests).
 */
export class NodeUpgrades implements AdapterUpgrades {
  readonly kind = 'node' as const
  #options: UpgradeHandlerOptions | undefined
  readonly #attached = new WeakSet<Server>()

  /** Whether {@link enable} was called. */
  get enabled(): boolean {
    return this.#options !== undefined
  }

  enable(options: UpgradeHandlerOptions): void {
    this.#options = options
  }

  /** Routes the gateway upgrades of `server` to the pipeline (once per server; no-op when not enabled). */
  attach(server: Server): void {
    const options = this.#options
    if (options === undefined || this.#attached.has(server)) return
    this.#attached.add(server)
    const matches = (request: IncomingMessage): boolean => {
      if (!isWebSocketUpgrade(request.headers as Record<string, string | undefined>)) return false
      const url = request.url ?? '/'
      const query = url.indexOf('?')
      return options.match(query === -1 ? url : url.slice(0, query))
    }
    const target = server as Server & { shouldUpgradeCallback?: (request: IncomingMessage) => boolean }
    const previous = target.shouldUpgradeCallback
    const composable = typeof previous === 'function'
    const listener = (request: IncomingMessage, socket: Duplex, head: Uint8Array): void => {
      if (!matches(request)) {
        // without shouldUpgradeCallback (Node.js < 24.12), every upgrade reaches the listeners: answer
        // the ones nobody else handles
        if (!composable && server.listenerCount('upgrade') === 1) {
          void writeRawRefusal(socket, { status: 404, headers: {}, body: null })
        }
        return
      }
      socket.on('error', () => socket.destroy())
      markUpgraded(socket)
      const native = { kind: 'node', request, socket, head } as const
      options.handle(new NodeUpgradeRequest(request, socket), native).then(
        reply => {
          if (reply !== undefined) void writeRawRefusal(socket, reply)
        },
        () => void writeRawRefusal(socket, FAILURE),
      )
    }
    if (previous !== undefined) {
      target.shouldUpgradeCallback = function (this: Server, request: IncomingMessage): boolean {
        if (matches(request)) return true
        // the server's callback without Znight's listener (Node's default counts the listeners)
        const self = this ?? server
        const view = Object.create(self, {
          listenerCount: {
            value: (name: string | symbol): number => self.listenerCount(name) - (name === 'upgrade' ? 1 : 0),
          },
        }) as Server
        return previous.call(view, request) === true
      }
    }
    server.on('upgrade', listener)
  }
}

/**
 * The `websocket` option of `Bun.serve()`: the plugins' settings, and handlers dispatching every
 * event to the {@link BunSocketHandlers} given as `data` to `server.upgrade()`.
 */
export function bunWebSocketOption(settings: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  type Socket = { readonly data: BunSocketHandlers }
  return Object.freeze({
    ...settings,
    open: (ws: Socket): void => ws.data.open(ws),
    message: (ws: Socket, message: string | Uint8Array): void => ws.data.message(ws, message),
    close: (ws: Socket, code: number, reason: string): void => ws.data.close(ws, code, reason),
    drain: (ws: Socket): void => ws.data.drain(ws),
    pong: (ws: Socket): void => ws.data.pong?.(ws),
  })
}

/** Builds the `Response` of a refused `Bun.serve()` upgrade. */
export async function refusalResponse(reply: AdapterReply): Promise<Response> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(reply.headers)) {
    for (const item of typeof value === 'string' ? [value] : value) headers.append(name, item)
  }
  const body = await replyBytes(reply)
  return new Response(body.byteLength === 0 ? null : body, { status: reply.status, headers })
}
