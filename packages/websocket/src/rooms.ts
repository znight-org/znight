/**
 * Rooms and broadcasts of one gateway (RFC 0003 §5.4): rooms are strings scoped per gateway,
 * created on first join and deleted when empty; a broadcast encodes its frame once, then sends it
 * to each selected member, which applies its own backpressure policy.
 */
import type { WsCodec } from './envelope.ts'

import { jsonCodec } from './envelope.ts'

/** What a room holds: a connection, seen through the operations rooms need. */
export interface ChannelMember {
  readonly id: string
  /** The rooms of the member, kept in sync by the channel. */
  readonly roomSet: Set<string>
  /** Sends an already encoded frame (`string`: text, `Uint8Array`: binary). */
  sendFrame(frame: string | Uint8Array): unknown
  close(code?: number, reason?: string): void
}

/** A target of `except()`: a member or its id. */
export type MemberRef<M extends ChannelMember = ChannelMember> = M | string

/** A selection of members of a gateway (RFC 0003 §5.4). */
export interface Broadcast<E extends object = Record<string, unknown>, M extends ChannelMember = ChannelMember> {
  to(room: string | readonly string[]): Broadcast<E, M>
  except(target: MemberRef<M> | readonly MemberRef<M>[]): Broadcast<E, M>
  exceptRoom(room: string | readonly string[]): Broadcast<E, M>
  emit<K extends keyof E & string>(event: K, data: E[K]): void
  send(frame: string | Uint8Array): void
  join(room: string): void
  leave(room: string): void
  close(code?: number, reason?: string): void
}

interface Selection {
  /** `undefined`: every member of the gateway. */
  readonly rooms: readonly string[] | undefined
  readonly except: ReadonlySet<string>
  readonly exceptRooms: readonly string[]
}

function list(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value
}

/** The members and rooms of one gateway. */
export class RoomRegistry<M extends ChannelMember = ChannelMember> {
  readonly #members = new Map<string, M>()
  readonly #rooms = new Map<string, Set<M>>()
  /** Encodes the events of broadcasts (once per broadcast). */
  readonly codec: WsCodec

  constructor(codec: WsCodec = jsonCodec) {
    this.codec = codec
  }

  /** Open members. */
  get size(): number {
    return this.#members.size
  }

  add(member: M): void {
    this.#members.set(member.id, member)
  }

  /** Removes the member and leaves its rooms. */
  remove(member: M): void {
    for (const room of [...member.roomSet]) this.leave(member, room)
    this.#members.delete(member.id)
  }

  get(id: string): M | undefined {
    return this.#members.get(id)
  }

  members(): IterableIterator<M> {
    return this.#members.values()
  }

  join(member: M, room: string): void {
    if (!this.#members.has(member.id)) return
    let set = this.#rooms.get(room)
    if (set === undefined) {
      set = new Set()
      this.#rooms.set(room, set)
    }
    set.add(member)
    member.roomSet.add(room)
  }

  leave(member: M, room: string): void {
    const set = this.#rooms.get(room)
    member.roomSet.delete(room)
    if (set === undefined) return
    set.delete(member)
    if (set.size === 0) this.#rooms.delete(room)
  }

  /** The members of `room` (a read-only view). */
  room(room: string): ReadonlySet<M> {
    return this.#rooms.get(room) ?? new Set()
  }

  /** Room → size. */
  rooms(): ReadonlyMap<string, number> {
    const sizes = new Map<string, number>()
    for (const [name, set] of this.#rooms) sizes.set(name, set.size)
    return sizes
  }

  /** A broadcast over every member, or over the members of `rooms`. */
  select<E extends object>(rooms?: string | readonly string[], except: readonly string[] = []): Broadcast<E, M> {
    return new BroadcastImpl<E, M>(this, {
      rooms: rooms === undefined ? undefined : list(rooms),
      except: new Set(except),
      exceptRooms: [],
    })
  }

  /** @internal The members a selection designates, each once. */
  resolve(selection: Selection): M[] {
    const excluded = new Set(selection.except)
    for (const room of selection.exceptRooms) for (const member of this.room(room)) excluded.add(member.id)
    const result: M[] = []
    const seen = new Set<string>()
    const sources = selection.rooms === undefined ? [this.#members.values()] : selection.rooms.map(r => this.room(r))
    for (const source of sources) {
      for (const member of source) {
        if (seen.has(member.id) || excluded.has(member.id)) continue
        seen.add(member.id)
        result.push(member)
      }
    }
    return result
  }
}

class BroadcastImpl<E extends object, M extends ChannelMember> implements Broadcast<E, M> {
  readonly #registry: RoomRegistry<M>
  readonly #selection: Selection

  constructor(registry: RoomRegistry<M>, selection: Selection) {
    this.#registry = registry
    this.#selection = selection
  }

  to(room: string | readonly string[]): Broadcast<E, M> {
    const rooms = [...(this.#selection.rooms ?? []), ...list(room)]
    return new BroadcastImpl(this.#registry, { ...this.#selection, rooms })
  }

  except(target: MemberRef<M> | readonly MemberRef<M>[]): Broadcast<E, M> {
    const refs: readonly MemberRef<M>[] = Array.isArray(target) ? target : [target as MemberRef<M>]
    const except = new Set(this.#selection.except)
    for (const ref of refs) except.add(typeof ref === 'string' ? ref : ref.id)
    return new BroadcastImpl(this.#registry, { ...this.#selection, except })
  }

  exceptRoom(room: string | readonly string[]): Broadcast<E, M> {
    return new BroadcastImpl(this.#registry, {
      ...this.#selection,
      exceptRooms: [...this.#selection.exceptRooms, ...list(room)],
    })
  }

  emit<K extends keyof E & string>(event: K, data: E[K]): void {
    this.send(this.#registry.codec.encode({ kind: 'event', event, data }))
  }

  send(frame: string | Uint8Array): void {
    for (const member of this.#registry.resolve(this.#selection)) member.sendFrame(frame)
  }

  join(room: string): void {
    for (const member of this.#registry.resolve(this.#selection)) this.#registry.join(member, room)
  }

  leave(room: string): void {
    for (const member of this.#registry.resolve(this.#selection)) this.#registry.leave(member, room)
  }

  close(code?: number, reason?: string): void {
    for (const member of this.#registry.resolve(this.#selection)) member.close(code, reason)
  }
}
