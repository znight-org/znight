/**
 * `WsServer` and `GatewayChannel` (RFC 0003 §5.4): the injectable view of the gateways, their
 * connections and rooms. `of()` is lazy: it never throws, a handle of an unknown gateway throws a
 * `TypeError` when used.
 */
import type { WsConnection, WsConnectionImpl } from './connection.ts'
import type { Broadcast, MemberRef, RoomRegistry } from './rooms.ts'

/** A gateway class or its declared path (`'/chat'`, without the HTTP prefix). */
export type GatewayRef = (abstract new (...args: never[]) => object) | string

/** The connections and rooms of one gateway (this process). */
export interface GatewayChannel<E extends object = Record<string, unknown>> {
  /** The gateway path, prefix included. */
  readonly path: string
  readonly size: number
  connection(id: string): WsConnection | undefined
  connections(): IterableIterator<WsConnection>
  members(room: string): ReadonlySet<WsConnection>
  rooms(): ReadonlyMap<string, number>
  to(room: string | readonly string[]): Broadcast<E>
  except(target: MemberRef<WsConnectionImpl> | readonly MemberRef<WsConnectionImpl>[]): Broadcast<E>
  emit<K extends keyof E & string>(event: K, data: E[K]): void
  send(frame: string | Uint8Array): void
}

/** One served gateway, as registered by the plugin. */
export interface ServedGateway {
  /** The gateway class. */
  readonly type: abstract new (
    ...args: never[]
  ) => object
  /** The declared path, without the prefix. */
  readonly declaredPath: string
  /** The path, prefix included. */
  readonly path: string
  readonly rooms: RoomRegistry<WsConnectionImpl>
}

/** The gateways of the application: injectable singleton provided by `WebSocketPlugin`. */
export class WsServer {
  readonly #byType = new Map<unknown, ServedGateway>()
  readonly #byPath = new Map<string, ServedGateway>()

  /** @internal Called by the plugin at bootstrap. */
  register(gateway: ServedGateway): void {
    this.#byType.set(gateway.type, gateway)
    this.#byPath.set(gateway.declaredPath, gateway)
  }

  /** @internal Called by the plugin when it serves a new application. */
  reset(): void {
    this.#byType.clear()
    this.#byPath.clear()
  }

  /** Open connections of every gateway of this process. */
  get connections(): number {
    let total = 0
    for (const gateway of this.#byType.values()) total += gateway.rooms.size
    return total
  }

  /** A lazy handle on a gateway: its class or its declared path. */
  of<E extends object = Record<string, unknown>>(gateway: GatewayRef): GatewayChannel<E> {
    return new Channel<E>(() => {
      const served = typeof gateway === 'string' ? this.#byPath.get(gateway) : this.#byType.get(gateway)
      if (served === undefined) {
        const name = typeof gateway === 'string' ? `"${gateway}"` : gateway.name
        throw new TypeError(
          `WsServer.of(${name}): no gateway is served for it (or WebSocketPlugin is not bootstrapped)`,
        )
      }
      return served
    })
  }
}

class Channel<E extends object> implements GatewayChannel<E> {
  readonly #resolve: () => ServedGateway

  constructor(resolve: () => ServedGateway) {
    this.#resolve = resolve
  }

  get path(): string {
    return this.#resolve().path
  }

  get size(): number {
    return this.#resolve().rooms.size
  }

  connection(id: string): WsConnection | undefined {
    return this.#resolve().rooms.get(id)
  }

  connections(): IterableIterator<WsConnection> {
    return this.#resolve().rooms.members()
  }

  members(room: string): ReadonlySet<WsConnection> {
    return this.#resolve().rooms.room(room)
  }

  rooms(): ReadonlyMap<string, number> {
    return this.#resolve().rooms.rooms()
  }

  to(room: string | readonly string[]): Broadcast<E> {
    return this.#resolve().rooms.select<E>(room)
  }

  except(target: MemberRef<WsConnectionImpl> | readonly MemberRef<WsConnectionImpl>[]): Broadcast<E> {
    return this.#resolve().rooms.select<E>().except(target)
  }

  emit<K extends keyof E & string>(event: K, data: E[K]): void {
    this.#resolve().rooms.select<E>().emit(event, data)
  }

  send(frame: string | Uint8Array): void {
    this.#resolve().rooms.select<E>().send(frame)
  }
}
