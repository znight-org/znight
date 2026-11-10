/**
 * WebSocket handshake check executed by `test/upgrade-abort-runtime.test.ts` with Node.js
 * (`node --conditions=@znight/source`) and Bun: on every adapter, a client leaving while a guard
 * waits aborts `ctx.signal` (`kind: 'client'`) and the handshake is not completed, also when it sent
 * bytes after its handshake before ending its side (bytes nothing reads yet), and a guard failing
 * with that abort logs no error; a connection
 * accepted then closed by its client aborts nothing, and the handshake stopped listening to the
 * client once accepted. Prints the results as JSON.
 */
import type { Duplex } from 'node:stream'
import type { Plugin } from '@znight/core'
import type {
  BunSocketHandlers,
  CanActivate,
  HttpContext,
  PendingUpgrade,
  PluginHttpUpgrades,
  RequestAbortedError,
} from '../../src/index.ts'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import net from 'node:net'

import { ADAPTERS, createApp, metadata, sleep } from '../helpers.ts'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

interface Run {
  entered: PromiseWithResolvers<void>
  /** Why `ctx.signal` aborted, `undefined` while it did not. */
  reason: string | undefined
  accepted: number
  /** `hold()` removed the client listeners of the handshake. */
  released: boolean | undefined
}

let run: Run = fresh()

function fresh(): Run {
  return { entered: Promise.withResolvers(), reason: undefined, accepted: 0, released: undefined }
}

/**
 * Waits on `ctx.signal` for `?slow`, then lets the handshake through, aborted or not; for `?rethrow`,
 * fails with the signal's reason once aborted (an authentication call given `ctx.signal`).
 */
class SlowGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean | Promise<boolean> {
    const signal = ctx.signal
    signal.addEventListener('abort', () => {
      run.reason = (signal.reason as RequestAbortedError).kind
    })
    run.entered.resolve()
    if (ctx.query['slow'] === undefined) return true
    const rethrow = ctx.query['rethrow'] !== undefined
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(true), 3000)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        if (rethrow) reject(signal.reason)
        else resolve(true)
      })
    })
  }
}

/**
 * The number of client listeners of a native upgrade (socket `end`, `close` and `readable`, request
 * `abort`).
 */
function listeners(upgrade: PendingUpgrade): number {
  const native = upgrade.native
  if (native.kind === 'node') {
    const socket = native.socket as Duplex
    return socket.listenerCount('end') + socket.listenerCount('close') + socket.listenerCount('readable')
  }
  if (native.kind === 'bun') return getEventListeners(native.request.signal, 'abort').length
  return 0
}

/** Completes the handshake natively; resolves when the connection closes. */
function complete(ctx: HttpContext, upgrade: PendingUpgrade): Promise<void> {
  const native = upgrade.native
  if (native.kind === 'bun') {
    const { promise, resolve } = Promise.withResolvers<void>()
    const handlers: BunSocketHandlers = {
      open: () => undefined,
      message: () => undefined,
      close: () => resolve(),
      drain: () => undefined,
    }
    const server = native.server as { upgrade(request: Request, options: object): boolean }
    if (!server.upgrade(native.request, { data: handlers })) throw new Error('not upgraded')
    return promise
  }
  if (native.kind !== 'node') throw new Error('unexpected memory upgrade')
  const socket = native.socket as Duplex
  const digest = createHash('sha1')
    .update((ctx.headers['sec-websocket-key'] ?? '') + GUID)
    .digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`,
  )
  // the server allows half-open sockets: end ours when the client ends its side
  socket.once('end', () => socket.end())
  return new Promise(resolve => socket.once('close', () => resolve()))
}

const plugin: Plugin & PluginHttpUpgrades = {
  name: 'fake-ws',
  httpUpgrades: () => ({
    routes: [
      {
        path: '/ws',
        name: 'FakeGateway',
        guards: [new SlowGuard()],
        accept(ctx: HttpContext, upgrade: PendingUpgrade): void {
          run.accepted++
          const closed = complete(ctx, upgrade)
          const before = listeners(upgrade)
          upgrade.hold(closed)
          run.released = listeners(upgrade) < before
        },
      },
    ],
  }),
}

async function until(condition: () => boolean, timeout = 3000): Promise<boolean> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) return false
    await sleep(10)
  }
  return true
}

/** Opens a raw connection and writes a handshake of `path`. */
function handshake(port: number, path: string): net.Socket {
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => undefined)
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  )
  return socket
}

const results: Record<string, unknown> = {}

for (const adapter of ADAPTERS) {
  const app = await createApp(metadata({}, []), { adapter: adapter.create() }, { plugins: [plugin] })
  const port = app.http.address?.port as number

  // the client leaves while the guard waits
  run = fresh()
  const leaving = handshake(port, '/ws?slow=1')
  await run.entered.promise
  const waiting = app.http.inflight
  leaving.destroy()
  const settled = await until(() => app.http.inflight === 0)
  await sleep(50)
  const left = { waiting, reason: run.reason ?? null, accepted: run.accepted, settled }

  // the client sends bytes after its handshake (a frame, in its own segment), then ends its side
  run = fresh()
  const ending = handshake(port, '/ws?slow=1')
  await run.entered.promise
  ending.write(Buffer.from([0x81, 0x80, 0, 0, 0, 0]))
  await sleep(50)
  ending.end()
  const ended = await until(() => app.http.inflight === 0)
  await sleep(50)
  ending.destroy()
  const sent = { reason: run.reason ?? null, accepted: run.accepted, settled: ended }

  // the guard fails with the client's abort: answered without an error log
  run = fresh()
  const errors = app.logger.entries.length
  const failing = handshake(port, '/ws?slow=1&rethrow=1')
  await run.entered.promise
  failing.destroy()
  const failed = await until(() => app.http.inflight === 0)
  await sleep(50)
  const rethrown = {
    reason: run.reason ?? null,
    accepted: run.accepted,
    settled: failed,
    errors: app.logger.entries.slice(errors).filter(entry => entry.level === 'error').length,
  }

  // accepted, then closed by the client
  run = fresh()
  const client = handshake(port, '/ws')
  const status = await new Promise<string>(resolve =>
    client.once('data', data => resolve(data.toString('latin1').split('\r\n')[0] ?? '')),
  )
  const open = app.http.inflight
  client.destroy()
  const closed = await until(() => app.http.inflight === 0)
  await sleep(50)
  const accepted = {
    status,
    open,
    closed,
    reason: run.reason ?? null,
    accepted: run.accepted,
    released: run.released ?? null,
  }

  results[adapter.name] = { left, sent, rethrown, accepted }
  await app.stop()
}

process.stdout.write(JSON.stringify(results))
process.exit(0)
