/**
 * Upgrade routes of plugins (RFC 0003 §8.2): the handshake pipeline, its refusals and the adapter
 * capability, exercised with a fake provider that completes the WebSocket handshake by hand.
 */

import type { Duplex } from 'node:stream'
import type { Plugin } from '@znight/core'
import type {
  BunSocketHandlers,
  CanActivate,
  HttpContext,
  PendingUpgrade,
  PluginHttpUpgrades,
  PluginUpgradeRoute,
} from '../src/index.ts'

import { createHash } from 'node:crypto'

import { ADAPTERS, createApp, metadata } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

class TokenGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    return ctx.query['token'] === 'secret'
  }
}

interface Accepted {
  readonly kind: string
  readonly path: string
  readonly params: Readonly<Record<string, string>>
}

/** A plugin serving `/ws/:room` and completing the handshake on every kind of native upgrade. */
function upgradePlugin(accepted: Accepted[], extra: Partial<PluginUpgradeRoute> = {}): Plugin & PluginHttpUpgrades {
  return {
    name: 'fake-ws',
    httpUpgrades: () => ({
      routes: [
        {
          path: '/ws/:room',
          name: 'FakeGateway',
          guards: [new TokenGuard()],
          accept(ctx: HttpContext, upgrade: PendingUpgrade): void {
            accepted.push({ kind: upgrade.native.kind, path: ctx.path, params: { ...ctx.params } })
            upgrade.hold(complete(ctx, upgrade))
          },
          ...extra,
        },
      ],
    }),
  }
}

/** Completes the handshake natively; resolves when the connection closes. */
function complete(ctx: HttpContext, upgrade: PendingUpgrade): Promise<void> {
  const native = upgrade.native
  if (native.kind === 'memory') return Promise.resolve()
  if (native.kind === 'bun') {
    const { promise, resolve } = Promise.withResolvers<void>()
    const handlers: BunSocketHandlers = {
      open: ws => (ws as { close(): void }).close(),
      message: () => undefined,
      close: () => resolve(),
      drain: () => undefined,
    }
    const server = native.server as { upgrade(request: Request, options: object): boolean }
    server.upgrade(native.request, { data: handlers })
    return promise
  }
  const socket = native.socket as Duplex
  const key = ctx.headers['sec-websocket-key'] ?? ''
  const digest = createHash('sha1')
    .update(key + GUID)
    .digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`,
  )
  // a close frame (1000), then the end of the connection
  socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]))
  return new Promise(resolve => socket.once('close', () => resolve()))
}

/** Opens a WebSocket client; resolves with `open` or with the error event. */
function connect(url: string): Promise<'open' | 'error'> {
  return new Promise(resolve => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve('open')
    ws.onerror = () => resolve('error')
  })
}

describe('upgrade routes in memory', () => {
  it('runs the handshake through the guards and gives the memory peer to accept()', async () => {
    const accepted: Accepted[] = []
    const { http, stop } = await createApp(metadata({}, []), {}, { plugins: [upgradePlugin(accepted)], start: false })
    try {
      const peer = {}
      expect(
        await http.upgradeInMemory({ method: 'GET', url: '/ws/lobby?token=secret' }, { kind: 'memory', peer }),
      ).toBeUndefined()
      expect(accepted).toEqual([{ kind: 'memory', path: '/ws/lobby', params: { room: 'lobby' } }])

      const refused = await http.upgradeInMemory({ method: 'GET', url: '/ws/lobby' }, { kind: 'memory', peer })
      expect(refused?.status).toBe(403)
      expect(accepted).toHaveLength(1)
    } finally {
      await stop()
    }
  })

  it('aborts ctx.signal (expired) when the handshake times out (408)', async () => {
    let aborted: unknown
    class WaitingGuard implements CanActivate {
      canActivate(ctx: HttpContext): Promise<boolean> {
        return new Promise(resolve =>
          ctx.signal.addEventListener('abort', () => {
            aborted = ctx.signal.reason
            resolve(false)
          }),
        )
      }
    }
    const accepted: Accepted[] = []
    const { http, stop } = await createApp(
      metadata({}, []),
      {},
      { plugins: [upgradePlugin(accepted, { timeoutMs: 30, guards: [new WaitingGuard()] })], start: false },
    )
    try {
      const reply = await http.upgradeInMemory({ method: 'GET', url: '/ws/a' }, { kind: 'memory', peer: {} })
      expect(reply?.status).toBe(408)
      await Promise.resolve()
      expect(aborted).toMatchObject({ name: 'AbortError', kind: 'expired' })
      // the guard settled: the handshake left the pipeline
      expect(http.inflight).toBe(0)
      expect(accepted).toEqual([])
    } finally {
      await stop()
    }
  })

  it('refuses an unsupported version (426) and an invalid key (400)', async () => {
    const accepted: Accepted[] = []
    const { http, stop } = await createApp(metadata({}, []), {}, { plugins: [upgradePlugin(accepted)], start: false })
    try {
      const peer = { kind: 'memory', peer: {} } as const
      const version = await http.upgradeInMemory(
        { method: 'GET', url: '/ws/a?token=secret', headers: { 'sec-websocket-version': '8' } },
        peer,
      )
      expect(version?.status).toBe(426)
      expect(version?.headers['sec-websocket-version']).toBe('13')
      const key = await http.upgradeInMemory(
        { method: 'GET', url: '/ws/a?token=secret', headers: { 'sec-websocket-key': 'short' } },
        peer,
      )
      expect(key?.status).toBe(400)
      expect(accepted).toEqual([])
    } finally {
      await stop()
    }
  })

  it('answers 426 to a plain GET of an upgrade path, 404 elsewhere', async () => {
    const { http, stop } = await createApp(metadata({}, []), {}, { plugins: [upgradePlugin([])], start: false })
    try {
      expect((await http.inject({ method: 'GET', url: '/ws/lobby' })).status).toBe(426)
      expect((await http.inject({ method: 'GET', url: '/nothing' })).status).toBe(404)
    } finally {
      await stop()
    }
  })

  it('lists the upgrade route', async () => {
    const { http, stop } = await createApp(metadata({}, []), {}, { plugins: [upgradePlugin([])], start: false })
    try {
      expect(http.routes.find(route => route.upgrade === 'websocket')).toMatchObject({
        method: 'GET',
        path: '/ws/:room',
      })
    } finally {
      await stop()
    }
  })
})

describe.each(ADAPTERS)('upgrade routes on the $name adapter', ({ create }) => {
  it('upgrades an accepted handshake and refuses the guard denial', async () => {
    const accepted: Accepted[] = []
    const { http, stop } = await createApp(
      metadata({}, []),
      { adapter: create() },
      { plugins: [upgradePlugin(accepted)] },
    )
    try {
      const base = `ws://127.0.0.1:${http.address?.port}`
      expect(await connect(`${base}/ws/lobby?token=secret`)).toBe('open')
      expect(accepted).toHaveLength(1)
      expect(accepted[0]?.params).toEqual({ room: 'lobby' })
      expect(await connect(`${base}/ws/lobby`)).toBe('error')
      expect(accepted).toHaveLength(1)
    } finally {
      await stop()
    }
  })
})
