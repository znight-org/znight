/**
 * `@znight/websocket/testing` (RFC 0003 §5.10): fakes for unit tests of gateways and services.
 * `createTestConnection()` is a `WsConnection` recording what the code under test sends to it;
 * `createTestServer()` is a `WsServer` recording broadcasts instead of delivering them.
 *
 * ```ts
 * const server = createTestServer({ paths: [[ChatGateway, '/chat']] })
 * const { instance } = await TestBed.create(ChatGateway, { metadata, overrides: [[WsServer, server]] })
 * const conn = createTestConnection<ChatData, ChatEvents>({ data: { user: ALICE }, rooms: ['general'] })
 * await instance.send(conn, { room: 'general', text: 'hi' })
 * expect(server.broadcasts).toEqual([{ gateway: '/chat', rooms: ['general'], except: [], event: 'message.new', data: MESSAGE }])
 * ```
 */
import type { HttpContext } from '@znight/http'
import type { WsCloseInfo, WsConnection, WsSendResult } from '../connection.ts'
import type { Broadcast } from '../rooms.ts'
import type { GatewayChannel, GatewayRef } from '../server.ts'

import { WsServer } from '../server.ts'

/** One recorded broadcast (or a `close`, `join` or `leave` of a selection). */
export interface RecordedBroadcast {
  /** The gateway path, or the class name when no path was given for it. */
  readonly gateway: string
  /** Selected rooms, `[]` for every connection of the gateway. */
  readonly rooms: readonly string[]
  /** Excluded connection ids. */
  readonly except: readonly string[]
  /** Excluded rooms (omitted when none). */
  readonly exceptRooms?: readonly string[]
  /** The emitted event, `undefined` for `send()` and the selection operations. */
  readonly event?: string
  readonly data?: unknown
  /** A raw frame (`send()`). */
  readonly frame?: string | Uint8Array
  /** `join`, `leave` or `close` of the selection. */
  readonly action?: 'join' | 'leave' | 'close'
  readonly room?: string
}

/** Options of {@link createTestConnection}. */
export interface TestConnectionOptions<TData extends object> {
  readonly id?: string
  /** Gateway path. Default: `'/'`. */
  readonly gateway?: string
  readonly data?: TData
  readonly rooms?: readonly string[]
  readonly params?: Readonly<Record<string, string>>
  readonly protocol?: string
  readonly requestId?: string
  /** The handshake context. Default: a minimal object with `params`, `query`, `headers` and `state`. */
  readonly handshake?: Partial<HttpContext>
}

/** A fake connection: a `WsConnection` with the record of what it was sent. */
export interface TestConnection<
  TData extends object = Record<string, unknown>,
  E extends object = Record<string, unknown>,
> extends WsConnection<TData, E> {
  /** Events emitted to this connection only (`conn.emit`), in order. */
  readonly emitted: { readonly event: string; readonly data: unknown }[]
  /** Raw frames sent to this connection (`conn.send`). */
  readonly sent: (string | Uint8Array)[]
  /** Broadcasts made through `conn.to()` (the connection itself is in `except`). */
  readonly broadcasts: RecordedBroadcast[]
}

/** A fake server: a `WsServer` recording broadcasts. */
export interface TestServer extends WsServer {
  readonly broadcasts: RecordedBroadcast[]
}

type Record_ = (entry: RecordedBroadcast) => void

/** A selection recording what is done with it. */
class RecordingBroadcast<E extends object> implements Broadcast<E> {
  readonly #gateway: string
  readonly #rooms: readonly string[]
  readonly #except: readonly string[]
  readonly #exceptRooms: readonly string[]
  readonly #record: Record_

  constructor(
    gateway: string,
    rooms: readonly string[],
    except: readonly string[],
    exceptRooms: readonly string[],
    record: Record_,
  ) {
    this.#gateway = gateway
    this.#rooms = rooms
    this.#except = except
    this.#exceptRooms = exceptRooms
    this.#record = record
  }

  to(room: string | readonly string[]): Broadcast<E> {
    return new RecordingBroadcast(
      this.#gateway,
      [...this.#rooms, ...list(room)],
      this.#except,
      this.#exceptRooms,
      this.#record,
    )
  }

  except(target: string | { readonly id: string } | readonly (string | { readonly id: string })[]): Broadcast<E> {
    const refs = Array.isArray(target) ? target : [target]
    const ids = refs.map(ref => (typeof ref === 'string' ? ref : (ref as { readonly id: string }).id))
    return new RecordingBroadcast(
      this.#gateway,
      this.#rooms,
      [...this.#except, ...ids],
      this.#exceptRooms,
      this.#record,
    )
  }

  exceptRoom(room: string | readonly string[]): Broadcast<E> {
    return new RecordingBroadcast(
      this.#gateway,
      this.#rooms,
      this.#except,
      [...this.#exceptRooms, ...list(room)],
      this.#record,
    )
  }

  emit<K extends keyof E & string>(event: K, data: E[K]): void {
    this.#record({ ...this.#base(), event, data })
  }

  send(frame: string | Uint8Array): void {
    this.#record({ ...this.#base(), frame })
  }

  join(room: string): void {
    this.#record({ ...this.#base(), action: 'join', room })
  }

  leave(room: string): void {
    this.#record({ ...this.#base(), action: 'leave', room })
  }

  close(): void {
    this.#record({ ...this.#base(), action: 'close' })
  }

  #base(): RecordedBroadcast {
    return {
      gateway: this.#gateway,
      rooms: [...this.#rooms],
      except: [...this.#except],
      ...(this.#exceptRooms.length === 0 ? {} : { exceptRooms: [...this.#exceptRooms] }),
    }
  }
}

function list(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value
}

/** Creates a fake connection for unit tests. */
export function createTestConnection<
  TData extends object = Record<string, unknown>,
  E extends object = Record<string, unknown>,
>(options: TestConnectionOptions<TData> = {}): TestConnection<TData, E> {
  const id = options.id ?? crypto.randomUUID()
  const gateway = options.gateway ?? '/'
  const rooms = new Set(options.rooms ?? [])
  const abort = new AbortController()
  const params = options.params ?? {}
  const handshake = {
    params,
    query: {},
    headers: {},
    state: new Map(),
    requestId: options.requestId ?? 'test-request',
    ...options.handshake,
  } as unknown as HttpContext
  let state: 'open' | 'closing' | 'closed' = 'open'
  let closeInfo: WsCloseInfo | undefined
  const emitted: { event: string; data: unknown }[] = []
  const sent: (string | Uint8Array)[] = []
  const broadcasts: RecordedBroadcast[] = []
  const result = (): WsSendResult => (state === 'open' ? 'sent' : 'dropped')
  const connection: TestConnection<TData, E> = {
    id,
    gateway,
    requestId: options.requestId ?? 'test-request',
    handshake,
    params,
    protocol: options.protocol ?? '',
    data: (options.data ?? {}) as TData,
    rooms,
    get readyState() {
      return state
    },
    bufferedAmount: 0,
    signal: abort.signal,
    get closeInfo() {
      return closeInfo
    },
    emitted,
    sent,
    broadcasts,
    emit(event, data) {
      if (state === 'open') emitted.push({ event, data })
      return result()
    },
    send(frame) {
      if (state === 'open') sent.push(frame)
      return result()
    },
    join(room) {
      for (const name of list(room)) rooms.add(name)
    },
    leave(room) {
      rooms.delete(room)
    },
    to(room) {
      return new RecordingBroadcast<E>(gateway, list(room), [id], [], entry => broadcasts.push(entry))
    },
    drained() {
      return state === 'open' ? Promise.resolve() : Promise.reject(new Error('The WebSocket connection is closed'))
    },
    close(code = 1000, reason = '') {
      if (state !== 'open') return
      state = 'closed'
      closeInfo = { code, reason, initiator: 'server' }
      abort.abort()
    },
    terminate() {
      if (state !== 'open') return
      state = 'closed'
      closeInfo = { code: 1006, reason: '', initiator: 'server' }
      abort.abort()
    },
  }
  return connection
}

/** Options of {@link createTestServer}. */
export interface TestServerOptions {
  /** Paths of gateway classes, for the `gateway` of recorded broadcasts (`[[ChatGateway, '/chat']]`). */
  readonly paths?: readonly (readonly [abstract new (...args: never[]) => object, string])[]
}

/** Creates a fake `WsServer` recording broadcasts (no connection, every room empty). */
export function createTestServer(options: TestServerOptions = {}): TestServer {
  const paths = new Map<unknown, string>(options.paths ?? [])
  const broadcasts: RecordedBroadcast[] = []
  const record: Record_ = entry => broadcasts.push(entry)
  class FakeServer extends WsServer {
    readonly broadcasts: RecordedBroadcast[] = broadcasts

    override get connections(): number {
      return 0
    }

    override of<E extends object = Record<string, unknown>>(gateway: GatewayRef): GatewayChannel<E> {
      const path = typeof gateway === 'string' ? gateway : (paths.get(gateway) ?? gateway.name)
      const all = (): RecordingBroadcast<E> => new RecordingBroadcast<E>(path, [], [], [], record)
      return {
        path,
        size: 0,
        connection: () => undefined,
        connections: () => [][Symbol.iterator](),
        members: () => new Set(),
        rooms: () => new Map(),
        to: room => all().to(room),
        except: target => all().except(target as never),
        emit: (event, data) => all().emit(event, data),
        send: frame => all().send(frame),
      }
    }
  }
  return new FakeServer()
}
