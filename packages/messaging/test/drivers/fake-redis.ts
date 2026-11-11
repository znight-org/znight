/**
 * An in-memory Redis implementing the commands the Redis Streams driver sends through ioredis'
 * `call()` / `callBuffer()`: streams (XADD with MAXLEN, XGROUP, XREADGROUP on several streams with
 * BLOCK, XACK, XAUTOCLAIM, XCLAIM JUSTID, XPENDING), TYPE, WAIT, PING, INFO, CLIENT ID / UNBLOCK, and
 * the driver's Lua scripts
 * (EVALSHA answers NOSCRIPT until EVAL loaded the script; a script is recognised by its
 * `-- znight:<name>` first line and run by a JavaScript twin). Every command is recorded.
 *
 * `FakeRedis` is the server; `connection()` and `duplicate()` return clients shaped like ioredis'
 * `Redis` (the subset the driver uses); `reconnect()` simulates a reconnection (a new client id).
 */
import { createHash } from 'node:crypto'

type Fields = [string, Buffer][]

interface Entry {
  readonly id: string
  readonly fields: Fields
}

interface PendingEntry {
  consumer: string
  deliveredAt: number
  deliveries: number
}

interface Group {
  lastId: string
  readonly pending: Map<string, PendingEntry>
  /** Consumers and the time they were last seen (XINFO CONSUMERS `idle`). */
  readonly consumers: Map<string, number>
}

interface Stream {
  readonly kind: 'stream'
  readonly entries: Entry[]
  readonly groups: Map<string, Group>
  lastId: string
}

interface SortedSet {
  readonly kind: 'zset'
  readonly members: Map<string, { score: number; fields: Fields }>
}

interface Plain {
  readonly kind: 'string'
  value: string
}

type Value = Stream | SortedSet | Plain

/** A recorded command. */
export interface FakeRedisCall {
  /** Id of the connection that sent it. */
  readonly connection: number
  readonly command: string
  readonly args: readonly string[]
}

/** A Redis error reply (ioredis `ReplyError`). */
export class FakeReplyError extends Error {
  override readonly name = 'ReplyError'
}

function compareIds(a: string, b: string): number {
  const [am = '0', as = '0'] = a.split('-')
  const [bm = '0', bs = '0'] = b.split('-')
  const ms = BigInt(am) - BigInt(bm)
  if (ms !== 0n) return ms < 0n ? -1 : 1
  const seq = BigInt(as) - BigInt(bs)
  if (seq === 0n) return 0
  return seq < 0n ? -1 : 1
}

function text(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

function buffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value))
}

/** Converts a reply to strings (ioredis `call`) — Buffers become strings, recursively. */
function toStrings(reply: unknown): unknown {
  if (Buffer.isBuffer(reply)) return reply.toString('utf8')
  if (Array.isArray(reply)) return reply.map(toStrings)
  return reply
}

export class FakeRedis {
  readonly calls: FakeRedisCall[] = []
  readonly data = new Map<string, Value>()
  /** Fails a command when it returns an error (checked before the command runs). */
  failures: (command: string, args: readonly string[]) => Error | undefined = () => undefined
  /** Answers `XREADGROUP` as a RESP3 map (ioredis 6 default protocol), flattened. */
  resp3 = false
  /** Replicas acknowledging a WAIT. */
  replicas = 0
  /** `redis_version` reported by INFO. */
  version = '7.4.0'
  /** Script SHAs loaded by EVAL. */
  readonly scripts = new Set<string>()
  /** Connections, by id. */
  readonly connections = new Map<number, FakeRedisConnection>()
  #connectionIds = 0
  readonly #waiters = new Set<() => void>()

  /** The next client id (ids grow, like the server's). */
  nextClientId(): number {
    this.#connectionIds += 1
    return this.#connectionIds
  }

  /** A new client connection (`id`: its client id, the next one by default). */
  connection(id = this.nextClientId()): FakeRedisConnection {
    const connection = new FakeRedisConnection(this, id)
    this.connections.set(connection.id, connection)
    return connection
  }

  /** Commands named `command` (upper case), in order. */
  callsOf(command: string): FakeRedisCall[] {
    return this.calls.filter(call => call.command === command)
  }

  /** The entries of a stream, fields decoded as strings (except `body`, a Buffer). */
  entries(key: string): { id: string; fields: Record<string, string> }[] {
    const value = this.data.get(key)
    if (value === undefined) return []
    if (value.kind !== 'stream') throw new Error(`${key} is not a stream`)
    return value.entries.map(entry => ({
      id: entry.id,
      fields: Object.fromEntries(entry.fields.map(([name, data]) => [name, data.toString('utf8')])),
    }))
  }

  /** The pending entries list of a group. */
  pending(key: string, group: string): { id: string; consumer: string; deliveries: number }[] {
    const value = this.data.get(key)
    if (value?.kind !== 'stream') return []
    const state = value.groups.get(group)
    if (state === undefined) return []
    return [...state.pending.entries()]
      .sort(([a], [b]) => compareIds(a, b))
      .map(([id, entry]) => ({ id, consumer: entry.consumer, deliveries: entry.deliveries }))
  }

  /** Consumers of a group. */
  consumers(key: string, group: string): string[] {
    const value = this.data.get(key)
    if (value?.kind !== 'stream') return []
    return [...(value.groups.get(group)?.consumers.keys() ?? [])]
  }

  /** Adds a consumer to a group, idle for `idleMs` (a consumer of a crashed process). */
  idleConsumer(key: string, group: string, consumer: string, idleMs: number): void {
    this.#group(key, group).consumers.set(consumer, Date.now() - idleMs)
  }

  /** Gives a connection another client id (a reconnection), keeping its pending blocking read. */
  renumber(connection: FakeRedisConnection, id = this.nextClientId()): void {
    if (this.connections.get(connection.id) === connection) this.connections.delete(connection.id)
    connection.id = id
    this.connections.set(id, connection)
  }

  /** Members of a sorted set (the delayed messages), with their due time. */
  delayed(key: string): { score: number; fields: Record<string, string> }[] {
    const value = this.data.get(key)
    if (value?.kind !== 'zset') return []
    return [...value.members.values()].map(member => ({
      score: member.score,
      fields: Object.fromEntries(member.fields.map(([name, data]) => [name, data.toString('utf8')])),
    }))
  }

  /** Adds an entry as another producer would (`XADD key * ...fields`). */
  add(key: string, fields: Record<string, string | Buffer>): string {
    return this.#xadd(
      key,
      Object.entries(fields).map(([name, value]) => [name, buffer(value)]),
      undefined,
    )
  }

  /** Stores a string key (to test keys of the wrong type). */
  set(key: string, value: string): void {
    this.data.set(key, { kind: 'string', value })
  }

  /** Runs a command for `connection`. */
  async execute(connection: FakeRedisConnection, command: string, args: readonly unknown[]): Promise<unknown> {
    const name = command.toUpperCase()
    const strings = args.map(text)
    this.calls.push({ connection: connection.id, command: name, args: strings })
    await Promise.resolve()
    const failure = this.failures(name, strings)
    if (failure !== undefined) throw failure
    switch (name) {
      case 'PING':
        return Buffer.from('PONG')
      case 'TYPE':
        return Buffer.from(this.data.get(strings[0] ?? '')?.kind ?? 'none')
      case 'WAIT':
        return this.replicas
      case 'INFO':
        return Buffer.from(`# Server\r\nredis_version:${this.version}\r\nredis_mode:standalone\r\n`)
      case 'CLIENT':
        return this.#client(connection, strings)
      case 'XADD':
        return Buffer.from(this.#xaddCommand(args))
      case 'XGROUP':
        return this.#xgroup(strings)
      case 'XREADGROUP':
        return await this.#xreadgroup(connection, strings)
      case 'XACK':
        return this.#xack(strings[0] ?? '', strings[1] ?? '', strings.slice(2))
      case 'XAUTOCLAIM':
        return this.#xautoclaim(strings)
      case 'XCLAIM':
        return this.#xclaim(strings)
      case 'XPENDING':
        return this.#xpending(strings)
      case 'EVAL':
        return this.#eval(String(args[0]), args.slice(1), true)
      case 'EVALSHA': {
        if (!this.scripts.has(strings[0] ?? '')) throw new FakeReplyError('NOSCRIPT No matching script.')
        return this.#eval(String(args[0]), args.slice(1), false)
      }
      default:
        throw new FakeReplyError(`ERR unknown command '${command}'`)
    }
  }

  // -----------------------------------------------------------------------------------------------

  #client(connection: FakeRedisConnection, args: readonly string[]): unknown {
    const sub = (args[0] ?? '').toUpperCase()
    if (sub === 'ID') return connection.id
    if (sub === 'UNBLOCK') {
      const target = this.connections.get(Number(args[1]))
      if (target?.unblock === undefined) return 0
      target.unblock()
      return 1
    }
    throw new FakeReplyError(`ERR unknown subcommand '${sub}'`)
  }

  #stream(key: string, create: boolean): Stream | undefined {
    const value = this.data.get(key)
    if (value === undefined) {
      if (!create) return undefined
      const stream: Stream = { kind: 'stream', entries: [], groups: new Map(), lastId: '0-0' }
      this.data.set(key, stream)
      return stream
    }
    if (value.kind !== 'stream') {
      throw new FakeReplyError('WRONGTYPE Operation against a key holding the wrong kind of value')
    }
    return value
  }

  #xaddCommand(args: readonly unknown[]): string {
    const key = text(args[0])
    let index = 1
    let maxLength: number | undefined
    if (text(args[index]).toUpperCase() === 'MAXLEN') {
      index++
      if (text(args[index]) === '~' || text(args[index]) === '=') index++
      maxLength = Number(text(args[index]))
      index++
    }
    if (text(args[index]) !== '*') throw new FakeReplyError('ERR the fake only supports * ids')
    index++
    const fields: Fields = []
    for (; index < args.length; index += 2) fields.push([text(args[index]), buffer(args[index + 1])])
    if (fields.length === 0) throw new FakeReplyError("ERR wrong number of arguments for 'xadd' command")
    return this.#xadd(key, fields, maxLength)
  }

  #xadd(key: string, fields: Fields, maxLength: number | undefined): string {
    const stream = this.#stream(key, true) as Stream
    const now = Date.now()
    const [lastMs = '0', lastSeq = '0'] = stream.lastId.split('-')
    const id = Number(lastMs) >= now ? `${lastMs}-${Number(lastSeq) + 1}` : `${now}-0`
    stream.lastId = id
    stream.entries.push({ id, fields })
    if (maxLength !== undefined && stream.entries.length > maxLength) {
      stream.entries.splice(0, stream.entries.length - maxLength)
    }
    for (const wake of [...this.#waiters]) wake()
    return id
  }

  #xgroup(args: readonly string[]): unknown {
    const sub = (args[0] ?? '').toUpperCase()
    const key = args[1] ?? ''
    const group = args[2] ?? ''
    if (sub === 'CREATE') {
      const mkstream = args.slice(4).some(arg => arg.toUpperCase() === 'MKSTREAM')
      const stream = this.#stream(key, mkstream)
      if (stream === undefined) throw new FakeReplyError('ERR The XGROUP subcommand requires the key to exist.')
      if (stream.groups.has(group)) throw new FakeReplyError('BUSYGROUP Consumer Group name already exists')
      const start = args[3] === '$' ? stream.lastId : (args[3] ?? '0')
      stream.groups.set(group, { lastId: start === '0' ? '0-0' : start, pending: new Map(), consumers: new Map() })
      return Buffer.from('OK')
    }
    if (sub === 'DELCONSUMER') {
      const state = this.#group(key, group)
      const consumer = args[3] ?? ''
      let count = 0
      for (const [id, entry] of state.pending) {
        if (entry.consumer === consumer) {
          state.pending.delete(id)
          count++
        }
      }
      state.consumers.delete(consumer)
      return count
    }
    throw new FakeReplyError(`ERR unknown subcommand '${sub}'`)
  }

  #group(key: string, group: string): Group {
    const state = this.#stream(key, false)?.groups.get(group)
    if (state === undefined) {
      throw new FakeReplyError(`NOGROUP No such key '${key}' or consumer group '${group}'`)
    }
    return state
  }

  #reply(entry: Entry): unknown[] {
    return [Buffer.from(entry.id), entry.fields.flatMap(([name, value]) => [Buffer.from(name), value])]
  }

  async #xreadgroup(connection: FakeRedisConnection, args: readonly string[]): Promise<unknown> {
    // XREADGROUP GROUP g c [COUNT n] [BLOCK ms] STREAMS key... id...
    const group = args[1] ?? ''
    const consumer = args[2] ?? ''
    let count = Number.POSITIVE_INFINITY
    let block: number | undefined
    let index = 3
    while (index < args.length && (args[index] ?? '').toUpperCase() !== 'STREAMS') {
      const option = (args[index] ?? '').toUpperCase()
      if (option === 'COUNT') count = Number(args[index + 1])
      if (option === 'BLOCK') block = Number(args[index + 1])
      index += 2
    }
    const rest = args.slice(index + 1)
    const keys = rest.slice(0, rest.length / 2)
    if (rest.slice(rest.length / 2).some(id => id !== '>')) {
      throw new FakeReplyError('ERR the fake only reads new entries (>)')
    }
    const read = (): unknown => {
      const replies: unknown[] = []
      for (const key of keys) {
        const stream = this.#stream(key, false)
        const state = this.#group(key, group)
        const now = Date.now()
        state.consumers.set(consumer, now)
        const fresh = (stream?.entries ?? []).filter(entry => compareIds(entry.id, state.lastId) > 0).slice(0, count)
        if (fresh.length === 0) continue
        for (const entry of fresh) {
          state.lastId = entry.id
          state.pending.set(entry.id, { consumer, deliveredAt: now, deliveries: 1 })
        }
        replies.push([Buffer.from(key), fresh.map(entry => this.#reply(entry))])
      }
      if (replies.length === 0) return undefined
      // RESP3 maps reach ioredis' callBuffer() flattened: [stream, entries, stream, entries...]
      return this.resp3 ? replies.flat(1) : replies
    }
    const immediate = read()
    if (immediate !== undefined || block === undefined) return immediate ?? null
    return await new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: unknown): void => {
        this.#waiters.delete(wake)
        if (timer !== undefined) clearTimeout(timer)
        connection.unblock = undefined
        connection.drop = undefined
        resolve(value)
      }
      const wake = (): void => {
        try {
          const value = read()
          if (value !== undefined) finish(value)
        } catch (error) {
          this.#waiters.delete(wake)
          reject(error)
        }
      }
      this.#waiters.add(wake)
      connection.unblock = () => finish(null)
      connection.drop = (error: Error) => {
        this.#waiters.delete(wake)
        if (timer !== undefined) clearTimeout(timer)
        reject(error)
      }
      if (block > 0) timer = setTimeout(() => finish(null), block)
    })
  }

  #xack(key: string, group: string, ids: readonly string[]): number {
    const stream = this.#stream(key, false)
    const state = stream?.groups.get(group)
    if (state === undefined) return 0
    let count = 0
    for (const id of ids) if (state.pending.delete(id)) count++
    return count
  }

  #xautoclaim(args: readonly string[]): unknown {
    // XAUTOCLAIM key group consumer min-idle start [COUNT n] [JUSTID]
    const [key = '', group = '', consumer = '', minIdle = '0', start = '0-0'] = args
    let count = 100
    const countAt = args.findIndex(arg => arg.toUpperCase() === 'COUNT')
    if (countAt >= 0) count = Number(args[countAt + 1])
    const stream = this.#stream(key, false)
    const state = this.#group(key, group)
    const now = Date.now()
    state.consumers.set(consumer, now)
    const candidates = [...state.pending.entries()]
      .filter(([id]) => compareIds(id, start) >= 0)
      .sort(([a], [b]) => compareIds(a, b))
    const claimed: unknown[] = []
    const deleted: Buffer[] = []
    let next = '0-0'
    let scanned = 0
    for (const [id, entry] of candidates) {
      if (scanned >= count) {
        next = id
        break
      }
      scanned++
      if (now - entry.deliveredAt < Number(minIdle)) continue
      const stored = stream?.entries.find(candidate => candidate.id === id)
      if (stored === undefined) {
        state.pending.delete(id)
        deleted.push(Buffer.from(id))
        continue
      }
      entry.consumer = consumer
      entry.deliveredAt = now
      entry.deliveries++
      claimed.push(this.#reply(stored))
    }
    return [Buffer.from(next), claimed, deleted]
  }

  #xclaim(args: readonly string[]): unknown {
    // XCLAIM key group consumer min-idle id... [JUSTID]
    const [key = '', group = '', consumer = '', minIdle = '0', ...rest] = args
    const justId = rest.some(arg => arg.toUpperCase() === 'JUSTID')
    const state = this.#group(key, group)
    const now = Date.now()
    state.consumers.set(consumer, now)
    const result: unknown[] = []
    for (const id of rest.filter(arg => arg.toUpperCase() !== 'JUSTID')) {
      const entry = state.pending.get(id)
      if (entry === undefined || now - entry.deliveredAt < Number(minIdle)) continue
      entry.consumer = consumer
      entry.deliveredAt = now
      if (!justId) entry.deliveries++
      result.push(Buffer.from(id))
    }
    return result
  }

  #xpending(args: readonly string[]): unknown {
    // XPENDING key group start end count [consumer]
    const [key = '', group = '', start = '-', end = '+', count = '10', consumer] = args
    const state = this.#group(key, group)
    const now = Date.now()
    return [...state.pending.entries()]
      .filter(([id, entry]) => {
        if (start !== '-' && compareIds(id, start) < 0) return false
        if (end !== '+' && compareIds(id, end) > 0) return false
        return consumer === undefined || entry.consumer === consumer
      })
      .sort(([a], [b]) => compareIds(a, b))
      .slice(0, Number(count))
      .map(([id, entry]) => [Buffer.from(id), Buffer.from(entry.consumer), now - entry.deliveredAt, entry.deliveries])
  }

  #eval(script: string, args: readonly unknown[], load: boolean): unknown {
    // EVAL script numkeys key... arg... (EVALSHA: the sha instead of the script)
    const keyCount = Number(text(args[0]))
    const keys = args.slice(1, 1 + keyCount).map(text)
    const argv = args.slice(1 + keyCount)
    let name: string | undefined
    if (load) {
      const sha = createHash('sha1').update(script).digest('hex')
      this.scripts.add(sha)
      this.#names.set(sha, /^-- znight:(\w+)/.exec(script)?.[1] ?? '')
      name = this.#names.get(sha)
    } else name = this.#names.get(script)
    switch (name) {
      case 'move':
        return this.#move(keys, argv)
      case 'schedule':
        return this.#schedule(keys, argv)
      case 'due':
        return this.#due(keys, argv)
      case 'retire':
        return this.#retire(keys, argv)
      case 'reap':
        return this.#reap(keys, argv)
      case 'trim':
        return this.#trim(keys, argv)
      default:
        throw new FakeReplyError(`ERR the fake does not know the script ${name ?? ''}`)
    }
  }

  readonly #names = new Map<string, string>()

  /** The source entry is acknowledged first; nothing else happens when it was not pending. */
  #acknowledged(source: string, group: string, entryId: string): boolean {
    if (entryId === '') return true
    return this.#xack(source, group, [entryId]) === 1
  }

  #fields(argv: readonly unknown[], from: number): Fields {
    const fields: Fields = []
    for (let index = from; index < argv.length; index += 2) {
      fields.push([text(argv[index]), buffer(argv[index + 1])])
    }
    return fields
  }

  // KEYS: target stream, source stream; ARGV: maxlen, group, entry id, fields...
  #move(keys: readonly string[], argv: readonly unknown[]): unknown {
    const [target = '', source = ''] = keys
    const maxLength = Number(text(argv[0]))
    if (!this.#acknowledged(source, text(argv[1]), text(argv[2]))) return 0
    this.#xadd(target, this.#fields(argv, 3), maxLength > 0 ? maxLength : undefined)
    return 1
  }

  // KEYS: delayed set, source stream; ARGV: delay ms, group, entry id, token, fields...
  #schedule(keys: readonly string[], argv: readonly unknown[]): unknown {
    const [delayed = '', source = ''] = keys
    if (!this.#acknowledged(source, text(argv[1]), text(argv[2]))) return 0
    let set = this.data.get(delayed)
    if (set === undefined) {
      set = { kind: 'zset', members: new Map() }
      this.data.set(delayed, set)
    }
    if (set.kind !== 'zset')
      throw new FakeReplyError('WRONGTYPE Operation against a key holding the wrong kind of value')
    set.members.set(text(argv[3]), { score: Date.now() + Number(text(argv[0])), fields: this.#fields(argv, 4) })
    return 1
  }

  // KEYS: delayed set, stream; ARGV: maxlen, limit
  #due(keys: readonly string[], argv: readonly unknown[]): unknown {
    const [delayed = '', stream = ''] = keys
    const set = this.data.get(delayed)
    if (set?.kind !== 'zset') return 0
    const maxLength = Number(text(argv[0]))
    const now = Date.now()
    const due = [...set.members.entries()]
      .filter(([, member]) => member.score <= now)
      .sort(([, a], [, b]) => a.score - b.score)
      .slice(0, Number(text(argv[1])))
    for (const [token, member] of due) {
      this.#xadd(stream, member.fields, maxLength > 0 ? maxLength : undefined)
      set.members.delete(token)
    }
    if (set.members.size === 0) this.data.delete(delayed)
    return due.length
  }

  // KEYS: streams; ARGV: group, consumer
  #retire(keys: readonly string[], argv: readonly unknown[]): unknown {
    const group = text(argv[0])
    const consumer = text(argv[1])
    const states = keys.map(key => this.#stream(key, false)?.groups.get(group))
    for (const state of states) {
      for (const entry of state?.pending.values() ?? []) if (entry.consumer === consumer) return 0
    }
    for (const state of states) state?.consumers.delete(consumer)
    return 1
  }

  // KEYS: stream; ARGV: group, idle ms, name prefix of the caller's consumers (kept)
  #reap(keys: readonly string[], argv: readonly unknown[]): unknown {
    const state = this.#stream(keys[0] ?? '', false)?.groups.get(text(argv[0]))
    if (state === undefined) return 0
    const now = Date.now()
    let removed = 0
    for (const [consumer, seenAt] of state.consumers) {
      const pending = [...state.pending.values()].some(entry => entry.consumer === consumer)
      const own = consumer.startsWith(text(argv[2]))
      if (!own && !pending && now - seenAt >= Number(text(argv[1]))) {
        state.consumers.delete(consumer)
        removed++
      }
    }
    return removed
  }

  // KEYS: stream; ARGV: limit. Trims exactly (the server trims whole macro nodes: `~`).
  #trim(keys: readonly string[], argv: readonly unknown[]): unknown {
    const stream = this.#stream(keys[0] ?? '', false)
    if (stream === undefined) return 0
    let oldest: string | undefined
    for (const state of stream.groups.values()) {
      const pending = [...state.pending.keys()].sort(compareIds)[0]
      const [ms = '0', seq = '0'] = state.lastId.split('-')
      // nothing pending: everything up to the last delivered entry is acknowledged
      const keep = pending ?? `${ms}-${BigInt(seq) + 1n}`
      if (oldest === undefined || compareIds(keep, oldest) < 0) oldest = keep
    }
    if (oldest === undefined) return 0
    const bound = oldest
    const kept = stream.entries.findIndex(entry => compareIds(entry.id, bound) >= 0)
    const removed = Math.min(kept === -1 ? stream.entries.length : kept, Number(text(argv[0])))
    stream.entries.splice(0, removed)
    return removed
  }
}

/** A client connection shaped like an ioredis `Redis` (the members the driver uses). */
export class FakeRedisConnection {
  status: 'wait' | 'ready' | 'end' = 'ready'
  /** Set while a blocking XREADGROUP waits: answers it with a nil reply (CLIENT UNBLOCK). */
  unblock: (() => void) | undefined
  /** Set while a blocking XREADGROUP waits: fails it (disconnect). */
  drop: ((error: Error) => void) | undefined
  quits = 0
  disconnects = 0
  readonly #listeners = new Map<string, (() => void)[]>()

  constructor(
    readonly server: FakeRedis,
    public id: number,
  ) {}

  /** Registers an event listener (`close` is the one the driver uses). */
  on(event: string, listener: () => void): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener])
    return this
  }

  /**
   * Simulates a reconnection: emits `close`, then takes another client id (`id`, the next one by
   * default). A pending blocking read is resent on the new connection, as ioredis does.
   */
  reconnect(id?: number): void {
    for (const listener of this.#listeners.get('close') ?? []) listener()
    this.server.renumber(this, id)
  }

  call(command: string, ...args: unknown[]): Promise<unknown> {
    return this.#run(command, args).then(toStrings)
  }

  callBuffer(command: string, ...args: unknown[]): Promise<unknown> {
    return this.#run(command, args)
  }

  async #run(command: string, args: unknown[]): Promise<unknown> {
    if (this.status === 'end') throw new Error('Connection is closed.')
    if (this.status === 'wait') this.status = 'ready'
    return await this.server.execute(this, command, args)
  }

  duplicate(): FakeRedisConnection {
    return this.server.connection()
  }

  connect(): Promise<void> {
    this.status = 'ready'
    return Promise.resolve()
  }

  quit(): Promise<'OK'> {
    this.quits++
    this.status = 'end'
    this.drop?.(new Error('Connection is closed.'))
    return Promise.resolve('OK')
  }

  disconnect(): void {
    this.disconnects++
    this.status = 'end'
    this.drop?.(new Error('Connection is closed.'))
  }
}
