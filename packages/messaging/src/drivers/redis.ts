/**
 * `@znight/messaging/redis`: Redis Streams driver built on ioredis 5 or 6 (optional peer dependency).
 * Design: RFC 0014 §4.3. Redis 7.0+ or Valkey 7.2+.
 *
 * - `publish(queue)` is an `XADD` to the stream `<prefix><queue>`: the body, the transport fields
 *   (`id`, `type`, `key`, `content-type`, `timestamp`) and one `h:<name>` field per header (trace
 *   context included), optionally trimmed with `MAXLEN ~`. `@Consumer(queue)` reads the stream
 *   through a consumer group (`XREADGROUP`, `COUNT` = free concurrency slots, on a dedicated blocking
 *   connection), created idempotently with `MKSTREAM`.
 * - `ack` is `XACK`. Retries, releases and dead letters add a copy and acknowledge the original in one
 *   Lua script: never lost, never duplicated by the driver. Retry and release copies go to the retry
 *   stream of the group (`<stream>:retry:<group>`, read next to the queue stream), so the other groups
 *   of a fan-out never see them; dead letters go to the dead-letter stream. Attempts are the
 *   `x-znight-attempt` header of the copy, plus the deliveries of entries claimed back from crashed
 *   consumers.
 * - Entries received but never settled stay in the group's pending entries list: any member claims
 *   them back with `XAUTOCLAIM` once idle for `claimIdleMs`; in-flight entries are kept claimed by a
 *   heartbeat (`XCLAIM ... JUSTID`).
 * - Delays go through sorted sets (`<stream>:delayed` for delayed publishing, `<retry stream>:delayed`
 *   for retries), scored by the server time and moved back into their stream by a script that the
 *   driver runs every `delayPollIntervalMs` for the streams it consumes or published delayed messages
 *   to.
 * - Housekeeping, every `claimIdleMs / 2` (30 s at most): the streams this process consumes are
 *   trimmed of the entries every group has read and acknowledged (`XTRIM MINID`, unless
 *   `keepAcknowledged`; retry streams always), and the consumers of crashed processes, idle without
 *   pending entries, are removed from their groups.
 * - Durability follows the server's persistence (AOF); `replicas` waits for replicas (`WAIT`) after
 *   every write. No ordering across the members of a group. Redis Cluster is not supported.
 */
import type { RedisOptions } from 'ioredis'
import type {
  DeadLetterRequest,
  DeliveryHandler,
  DriverCapabilities,
  DriverContext,
  DriverDelivery,
  MessagingDriver,
  RetryRequest,
  SubscribeOptions,
  Subscription,
} from '../driver.ts'
import type { OutboundMessage } from '../message.ts'

import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { Redis } from 'ioredis'

import { bodyToBytes } from '../codec.ts'
import { brokerUnavailableError, consumerError } from '../errors.ts'
import { attemptFromHeaders, headerRecord, MessagingHeaders } from '../headers.ts'
import { errorMessage, sleep } from '../internal/async.ts'
import { deadLetterHeaders, durationOption } from './shared.ts'

/**
 * Field names of a stream entry written by the driver. Entries written by other producers are read
 * too: a missing `id` falls back to the entry id, a missing `timestamp` to the entry time, and fields
 * that are neither transport fields nor `h:` headers are exposed as headers.
 */
export const RedisStreamFields: {
  /** The encoded body (binary safe). */
  readonly Body: 'body'
  /** The Znight message id. */
  readonly Id: 'id'
  /** The message type. */
  readonly Type: 'type'
  /** The message key. */
  readonly Key: 'key'
  /** The content type of the body. */
  readonly ContentType: 'content-type'
  /** Production time, epoch milliseconds. */
  readonly Timestamp: 'timestamp'
  /** Prefix of header fields: the header `traceparent` is the field `h:traceparent`. */
  readonly HeaderPrefix: 'h:'
} = Object.freeze({
  Body: 'body',
  Id: 'id',
  Type: 'type',
  Key: 'key',
  ContentType: 'content-type',
  Timestamp: 'timestamp',
  HeaderPrefix: 'h:',
})

/** Replicas a write must reach before it is confirmed (`WAIT`). */
export interface RedisReplicas {
  /** Number of replicas. */
  readonly count: number
  /** Longest wait, in milliseconds. Default: 1000. */
  readonly timeoutMs?: number
}

/** Options of {@link redis}. */
export interface RedisDriverOptions {
  /** Connection URL (`redis://`, `rediss://`). Default: `redis://localhost:6379`. Not with `client`. */
  readonly url?: string
  /** Options of the ioredis client created by the driver (password, TLS, Sentinel...). */
  readonly redisOptions?: RedisOptions
  /**
   * An existing ioredis client (standalone or Sentinel). You keep ownership: it is not closed. The
   * driver duplicates it for the blocking reads of each consumer.
   */
  readonly client?: Redis
  /** Prefix of the stream keys: `<prefix><queue>`. Default: none. */
  readonly prefix?: string
  /** Consumer group of the consumers. Default: `'znight'`. A consumer can name another: `@Consumer({ queue, group })`. */
  readonly group?: string
  /** Prefix of this process' consumer names in the groups. Default: `<hostname>-<pid>-<random>`. */
  readonly consumerName?: string
  /**
   * Approximate length of the queue streams (`MAXLEN ~` on every write). Trimming ignores the
   * consumers: size it above any backlog. Default: none (the housekeeping trims what every group
   * acknowledged).
   */
  readonly maxLength?: number
  /**
   * Keeps the entries every consumer group has acknowledged in the queue streams (the stream as a log,
   * bounded by `maxLength` only). Default: `false`, the housekeeping trims them (`XTRIM MINID`).
   */
  readonly keepAcknowledged?: boolean
  /** Approximate length of the dead-letter streams. Default: none. */
  readonly deadLetterMaxLength?: number
  /**
   * Idle time after which an entry left pending (crashed consumer) is claimed back. Default: 60 000 ms.
   * The housekeeping runs every half of it (30 s at most) and removes the consumers idle for ten times
   * as long without pending entries.
   */
  readonly claimIdleMs?: number
  /** Longest wait of a blocking read. Default: 2000 ms. */
  readonly blockMs?: number
  /** Interval of the delayed-set scheduler: the precision of delays. Default: 250 ms. */
  readonly delayPollIntervalMs?: number
  /** Longest retry delay waited in-process. Default: 1000 ms. */
  readonly maxInProcessDelayMs?: number
  /** First wait after a failed read (doubled up to 30 s). Default: 500 ms. */
  readonly readErrorDelayMs?: number
  /** Default dead-letter stream of a queue. Default: `<queue>.dlq`. */
  readonly deadLetterName?: (queue: string) => string
  /** Waits for replicas after every write (`WAIT`); a write reaching fewer replicas fails. Default: none. */
  readonly replicas?: RedisReplicas
}

/** The driver-native message of a delivery (`InboundMessage.raw`). */
export interface RedisStreamEntry {
  /** Stream key: the queue stream, or the retry stream of the group (`<stream>:retry:<group>`). */
  readonly stream: string
  readonly group: string
  readonly consumer: string
  /** Entry id (`<ms>-<seq>`). */
  readonly id: string
  /** Deliveries of the entry in the group (above 1 for entries claimed back). */
  readonly deliveries: number
  /** The entry's fields. */
  readonly fields: Readonly<Record<string, Uint8Array>>
}

/** Creates a {@link RedisStreamsDriver}. */
export function redis(options: RedisDriverOptions = {}): RedisStreamsDriver {
  return new RedisStreamsDriver(options)
}

const DEFAULT_GROUP = 'znight'
/** Most delayed messages moved per script run. */
const DUE_BATCH = 100
/** Most entries trimmed per script run. */
const TRIM_BATCH = 10_000
const MAX_ERROR_DELAY_MS = 30_000
/** Longest interval between two housekeeping runs. */
const MAX_HOUSEKEEPING_MS = 30_000
/** Oldest server major version (XAUTOCLAIM drops deleted entries from the pending list since 7.0). */
const MIN_SERVER_MAJOR = 7
const EMPTY = new Uint8Array()
const TRANSPORT_FIELDS = new Set<string>(Object.values(RedisStreamFields))

/** A Lua script run with `EVALSHA`, loaded with `EVAL` when the server does not know it. */
interface Script {
  readonly source: string
  readonly sha: string
}

function script(lines: readonly string[]): Script {
  const source = lines.join('\n')
  return { source, sha: createHash('sha1').update(source).digest('hex') }
}

const ADD_FIELDS = [
  'local function add(key, maxlen, fields, from)',
  "  local command = {'XADD', key}",
  "  if maxlen ~= '0' then",
  "    command[#command + 1] = 'MAXLEN'",
  "    command[#command + 1] = '~'",
  '    command[#command + 1] = maxlen',
  '  end',
  "  command[#command + 1] = '*'",
  '  for i = from, #fields do command[#command + 1] = fields[i] end',
  '  return redis.call(unpack(command))',
  'end',
]

const NOW = [
  "local time = redis.call('TIME')",
  'local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)',
]

/** Adds a copy to a stream and acknowledges the original, unless it is no longer pending. */
const MOVE = script([
  '-- znight:move',
  '-- KEYS[1]: target stream, KEYS[2]: source stream',
  "-- ARGV[1]: MAXLEN of the target ('0': none), ARGV[2]: group, ARGV[3]: source entry id, ARGV[4..]: fields",
  "if ARGV[3] ~= '' and redis.call('XACK', KEYS[2], ARGV[2], ARGV[3]) == 0 then return 0 end",
  ...ADD_FIELDS,
  'add(KEYS[1], ARGV[1], ARGV, 4)',
  'return 1',
])

/** Adds a copy to a delayed set (due at server time + delay) and acknowledges the original. */
const SCHEDULE = script([
  '-- znight:schedule',
  '-- KEYS[1]: delayed set, KEYS[2]: source stream',
  "-- ARGV[1]: delay (ms), ARGV[2]: group, ARGV[3]: source entry id ('': none), ARGV[4]: unique token, ARGV[5..]: fields",
  "if ARGV[3] ~= '' and redis.call('XACK', KEYS[2], ARGV[2], ARGV[3]) == 0 then return 0 end",
  ...NOW,
  'local member = {ARGV[4]}',
  'for i = 5, #ARGV do member[#member + 1] = ARGV[i] end',
  "redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), cmsgpack.pack(member))",
  'return 1',
])

/** Moves the due members of a delayed set into the stream. */
const DUE = script([
  '-- znight:due',
  '-- KEYS[1]: delayed set, KEYS[2]: stream',
  "-- ARGV[1]: MAXLEN of the stream ('0': none), ARGV[2]: most members moved",
  ...ADD_FIELDS,
  ...NOW,
  "local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[2]))",
  'for _, member in ipairs(due) do',
  '  add(KEYS[2], ARGV[1], cmsgpack.unpack(member), 2)',
  "  redis.call('ZREM', KEYS[1], member)",
  'end',
  'return #due',
])

/** Removes a consumer from its group on every stream, when it has no pending entry on any of them. */
const RETIRE = script([
  '-- znight:retire',
  '-- KEYS: streams; ARGV[1]: group, ARGV[2]: consumer',
  'for _, key in ipairs(KEYS) do',
  "  if #redis.call('XPENDING', key, ARGV[1], '-', '+', 1, ARGV[2]) > 0 then return 0 end",
  'end',
  "for _, key in ipairs(KEYS) do redis.call('XGROUP', 'DELCONSUMER', key, ARGV[1], ARGV[2]) end",
  'return 1',
])

/**
 * Removes the consumers of a group idle for `ARGV[2]` ms without pending entries (crashed processes),
 * except the consumers of this process (named `ARGV[3]...`).
 */
const REAP = script([
  '-- znight:reap',
  '-- KEYS[1]: stream; ARGV[1]: group, ARGV[2]: idle time (ms), ARGV[3]: name prefix of this process',
  "local consumers = redis.pcall('XINFO', 'CONSUMERS', KEYS[1], ARGV[1])",
  "if type(consumers) ~= 'table' or consumers.err then return 0 end",
  'local removed = 0',
  'for _, consumer in ipairs(consumers) do',
  '  local info = {}',
  '  for i = 1, #consumer, 2 do info[consumer[i]] = consumer[i + 1] end',
  "  local own = string.sub(info['name'], 1, #ARGV[3]) == ARGV[3]",
  "  if not own and tonumber(info['pending']) == 0 and tonumber(info['idle']) >= tonumber(ARGV[2]) then",
  "    redis.call('XGROUP', 'DELCONSUMER', KEYS[1], ARGV[1], info['name'])",
  '    removed = removed + 1',
  '  end',
  'end',
  'return removed',
])

/**
 * Trims the entries of a stream that every consumer group has read and acknowledged: those below, for
 * every group, its oldest pending entry, or the entry after its last delivered one when nothing is
 * pending. A stream without groups is left alone.
 */
const TRIM = script([
  '-- znight:trim',
  '-- KEYS[1]: stream; ARGV[1]: most entries trimmed',
  "local groups = redis.pcall('XINFO', 'GROUPS', KEYS[1])",
  "if type(groups) ~= 'table' or groups.err then return 0 end",
  'local function parse(id)',
  "  local ms, seq = string.match(id, '^(%d+)-(%d+)$')",
  '  return ms, tonumber(seq)',
  'end',
  'local function before(a, b)',
  '  local am, as = parse(a)',
  '  local bm, bs = parse(b)',
  '  am, bm = tonumber(am), tonumber(bm)',
  '  return am < bm or (am == bm and as < bs)',
  'end',
  'local oldest = nil',
  'for _, group in ipairs(groups) do',
  '  local info = {}',
  '  for i = 1, #group, 2 do info[group[i]] = group[i + 1] end',
  '  local keep',
  "  if tonumber(info['pending']) > 0 then",
  "    keep = redis.call('XPENDING', KEYS[1], info['name'])[2]",
  '  else',
  "    local ms, seq = parse(info['last-delivered-id'])",
  "    keep = ms .. '-' .. string.format('%d', seq + 1)",
  '  end',
  '  if oldest == nil or before(keep, oldest) then oldest = keep end',
  'end',
  'if oldest == nil then return 0 end',
  "return redis.call('XTRIM', KEYS[1], 'MINID', '~', oldest, 'LIMIT', tonumber(ARGV[1]))",
])

type Argument = string | Buffer | number

interface Entry {
  /** The stream the entry was read from. */
  readonly stream: string
  readonly id: string
  readonly fields: readonly (readonly [string, Buffer])[]
}

interface Decoded {
  readonly id: string
  readonly type: string | undefined
  readonly key: string | undefined
  readonly contentType: string | undefined
  readonly timestamp: number | undefined
  readonly headers: Record<string, string>
  readonly body: Uint8Array
}

/** A stream read by a subscription: the queue stream or the retry stream of its group. */
interface StreamState {
  readonly key: string
  /** Entry ids read and not settled yet (handed out or waiting in the backlog), kept claimed by the heartbeat. */
  readonly leased: Set<string>
  /** Next `XAUTOCLAIM` (epoch ms) and its cursor. */
  claimAt: number
  claimCursor: string
}

interface Received {
  readonly state: StreamState
  readonly entry: Entry
  /** Deliveries of the entry in the group (above 1 for entries claimed back). */
  readonly deliveries: number
}

interface StreamSubscription {
  readonly queue: string
  /** The queue stream and the retry stream of the group. */
  readonly main: StreamState
  readonly retry: StreamState
  readonly group: string
  readonly consumer: string
  readonly handler: DeliveryHandler
  readonly options: SubscribeOptions
  readonly blocking: Redis
  readonly abort: AbortController
  /** Entries read beyond the free slots (a read returns up to `COUNT` entries per stream). */
  readonly backlog: Received[]
  readonly handling: Set<Promise<void>>
  /** `CLIENT ID` of the blocking connection, `undefined` when unknown (read again after a reconnection). */
  clientId: number | undefined
  /** `CLIENT ID` is refused (ACL): stopping waits for the blocking read to time out. */
  clientIdRefused: boolean
  inflight: number
  active: boolean
  wake: (() => void) | undefined
  loop: Promise<void> | undefined
  heartbeat: ReturnType<typeof setInterval> | undefined
  closed: Promise<void> | undefined
}

interface Watched {
  readonly stream: string
  readonly delayed: string
  /** `MAXLEN` of the stream (`'0'`: none). */
  readonly maxLength: string
}

/** Redis Streams {@link MessagingDriver}. See the module documentation. */
export class RedisStreamsDriver implements MessagingDriver {
  readonly name = 'redis'
  readonly capabilities: DriverCapabilities
  readonly #options: RedisDriverOptions
  readonly #prefix: string
  readonly #group: string
  readonly #consumerBase: string
  readonly #maxLength: string
  readonly #deadLetterMaxLength: string
  readonly #keepAcknowledged: boolean
  readonly #claimIdleMs: number
  /** Idle time after which a consumer without pending entries is removed from its group. */
  readonly #reapIdleMs: number
  readonly #blockMs: number
  readonly #pollMs: number
  readonly #readErrorDelayMs: number
  readonly #replicas: Required<RedisReplicas> | undefined
  readonly #subscriptions = new Set<StreamSubscription>()
  /** Streams whose delayed set this driver moves (consumed, or published delayed messages to). */
  readonly #watched = new Map<string, Watched>()
  #client: Redis | undefined
  #owned = false
  #consumers = 0
  #poller: ReturnType<typeof setInterval> | undefined
  #polling: Promise<void> | undefined
  #pollFailing = false
  #housekeeper: ReturnType<typeof setInterval> | undefined
  #housekeeping: Promise<void> | undefined
  #housekeepingFailing = false
  #logger: DriverContext['logger'] = { debug() {}, info() {}, warn() {}, error() {} }
  #closed = false

  constructor(options: RedisDriverOptions = {}) {
    if (options.url !== undefined && options.client !== undefined) {
      throw new TypeError('[znight] redis(): pass either url (and redisOptions) or client, not both')
    }
    const group = options.group ?? DEFAULT_GROUP
    if (typeof group !== 'string' || group === '') {
      throw new TypeError(`[znight] redis(): group must be a non-empty string, got ${String(group)}`)
    }
    const replicas = options.replicas
    if (replicas !== undefined) {
      const timeoutMs = replicas.timeoutMs ?? 1000
      if (!(Number.isSafeInteger(replicas.count) && replicas.count >= 1)) {
        throw new TypeError(`[znight] redis(): replicas.count must be an integer >= 1, got ${String(replicas.count)}`)
      }
      if (!(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1)) {
        throw new TypeError(`[znight] redis(): replicas.timeoutMs must be an integer >= 1, got ${String(timeoutMs)}`)
      }
      this.#replicas = { count: replicas.count, timeoutMs }
    }
    this.#options = options
    this.#prefix = options.prefix ?? ''
    this.#group = group
    this.#consumerBase = options.consumerName ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
    this.#maxLength = lengthOption(options.maxLength, 'maxLength')
    this.#deadLetterMaxLength = lengthOption(options.deadLetterMaxLength, 'deadLetterMaxLength')
    this.#keepAcknowledged = options.keepAcknowledged === true
    this.#claimIdleMs = Math.max(1, durationOption(options.claimIdleMs, 60_000, 'redis claimIdleMs'))
    this.#blockMs = Math.max(1, Math.round(durationOption(options.blockMs, 2000, 'redis blockMs')))
    this.#reapIdleMs = Math.round(10 * Math.max(this.#claimIdleMs, this.#blockMs))
    this.#pollMs = Math.max(1, durationOption(options.delayPollIntervalMs, 250, 'redis delayPollIntervalMs'))
    this.#readErrorDelayMs = Math.max(1, durationOption(options.readErrorDelayMs, 500, 'redis readErrorDelayMs'))
    this.capabilities = Object.freeze({
      nativeDelay: true,
      maxNativeDelayMs: Number.POSITIVE_INFINITY,
      maxInProcessDelayMs: durationOption(options.maxInProcessDelayMs, 1000, 'redis maxInProcessDelayMs'),
      deliveryCount: 'header',
      maxPublishDelayMs: Number.POSITIVE_INFINITY,
    })
  }

  /** The client the driver writes with (available once connected). */
  get client(): Redis | undefined {
    return this.#client
  }

  async connect(context: DriverContext): Promise<void> {
    this.#logger = context.logger
    if (this.#closed) throw brokerUnavailableError('Redis: the driver is closed, create a new one')
    if (this.#client !== undefined) return
    const given = this.#options.client
    const client =
      given ??
      new Redis(this.#options.url ?? 'redis://localhost:6379', { ...this.#options.redisOptions, lazyConnect: true })
    try {
      if (client.status === 'wait') await client.connect()
      await client.call('PING')
    } catch (error) {
      if (given === undefined) client.disconnect()
      throw brokerUnavailableError(`Redis: cannot connect (${errorMessage(error)})`, error)
    }
    try {
      await this.#checkVersion(client)
    } catch (error) {
      if (given === undefined) client.disconnect()
      throw error
    }
    this.#client = client
    this.#owned = given === undefined
    this.#poller = setInterval(() => {
      if (this.#polling !== undefined) return
      const polling = this.#moveDue().finally(() => {
        this.#polling = undefined
      })
      this.#polling = polling
    }, this.#pollMs)
    this.#poller.unref?.()
    this.#housekeeper = setInterval(
      () => {
        if (this.#housekeeping !== undefined) return
        const housekeeping = this.#housekeep().finally(() => {
          this.#housekeeping = undefined
        })
        this.#housekeeping = housekeeping
      },
      Math.max(1, Math.min(this.#claimIdleMs / 2, MAX_HOUSEKEEPING_MS)),
    )
    this.#housekeeper.unref?.()
  }

  /** Refuses servers older than Redis 7.0 (Valkey reports 7.2+); skipped when `INFO` is not allowed. */
  async #checkVersion(client: Redis): Promise<void> {
    let info: string
    try {
      info = text(await client.call('INFO', 'server'))
    } catch (error) {
      this.#logger.debug('Redis: INFO failed, the server version is not checked', { err: error })
      return
    }
    const version = /^redis_version:(\S+)/m.exec(info)?.[1]
    const major = Number(version?.split('.', 1)[0])
    if (version !== undefined && Number.isInteger(major) && major < MIN_SERVER_MAJOR) {
      throw brokerUnavailableError(
        `Redis: the server runs Redis ${version}, the Redis Streams driver needs Redis 7.0 or later (or Valkey)`,
      )
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const subscriptions = [...this.#subscriptions]
    await Promise.all(subscriptions.map(subscription => this.#close(subscription)))
    if (this.#poller !== undefined) clearInterval(this.#poller)
    this.#poller = undefined
    if (this.#housekeeper !== undefined) clearInterval(this.#housekeeper)
    this.#housekeeper = undefined
    await Promise.all([this.#polling, this.#housekeeping])
    const client = this.#client
    this.#client = undefined
    if (client !== undefined && this.#owned) await quit(client)
  }

  deadLetterName(queue: string): string {
    return this.#options.deadLetterName?.(queue) ?? `${queue}.dlq`
  }

  #key(queue: string): string {
    return `${this.#prefix}${queue}`
  }

  #main(action: string): Redis {
    const client = this.#client
    if (client === undefined) {
      throw brokerUnavailableError(
        this.#closed ? `Redis: cannot ${action}, the driver is closed` : `Redis: cannot ${action} before connect()`,
      )
    }
    return client
  }

  /** Runs a script (`EVALSHA`, then `EVAL` when the server does not know it); its integer reply. */
  async #script(action: string, run: Script, keys: readonly string[], args: readonly Argument[]): Promise<number> {
    const client = this.#main(action)
    try {
      return Number(await client.call('EVALSHA', run.sha, keys.length, ...keys, ...args))
    } catch (error) {
      if (!errorMessage(error).startsWith('NOSCRIPT')) throw error
      return Number(await client.call('EVAL', run.source, keys.length, ...keys, ...args))
    }
  }

  /** Waits for the replicas (`replicas` option) after a write of the main connection. */
  async #confirm(): Promise<void> {
    const replicas = this.#replicas
    if (replicas === undefined) return
    const reached = Number(await this.#main('wait for replicas').call('WAIT', replicas.count, replicas.timeoutMs))
    if (reached < replicas.count) {
      throw new Error(
        `[znight] Redis: the write reached ${reached} of ${replicas.count} replica(s) within ${replicas.timeoutMs} ms`,
      )
    }
  }

  #watch(stream: string, maxLength: string): void {
    if (!this.#watched.has(stream)) this.#watched.set(stream, { stream, delayed: `${stream}:delayed`, maxLength })
  }

  /** Moves the due delayed messages of the watched streams (one scheduler tick). */
  async #moveDue(): Promise<void> {
    const client = this.#client
    if (client === undefined) return
    try {
      for (const watched of this.#watched.values()) {
        let moved = DUE_BATCH
        while (moved >= DUE_BATCH && this.#client !== undefined) {
          moved = await this.#script(
            'move delayed messages',
            DUE,
            [watched.delayed, watched.stream],
            [watched.maxLength, DUE_BATCH],
          )
        }
      }
      this.#pollFailing = false
    } catch (error) {
      if (this.#client === undefined) return
      const log = this.#pollFailing ? this.#logger.debug : this.#logger.warn
      this.#pollFailing = true
      log.call(this.#logger, 'Redis: moving the due delayed messages failed, retrying', { err: error })
    }
  }

  /**
   * One housekeeping run over the streams this process consumes: removes the consumers of crashed
   * processes (idle without pending entries) and trims what every group acknowledged.
   */
  async #housekeep(): Promise<void> {
    const groups = new Map<string, Set<string>>()
    const trimmed = new Set<string>()
    for (const subscription of this.#subscriptions) {
      if (!subscription.active) continue
      for (const state of [subscription.main, subscription.retry]) {
        const names = groups.get(state.key) ?? new Set<string>()
        names.add(subscription.group)
        groups.set(state.key, names)
      }
      // the retry streams are internal: always trimmed
      trimmed.add(subscription.retry.key)
      if (!this.#keepAcknowledged) trimmed.add(subscription.main.key)
    }
    try {
      for (const [stream, names] of groups) {
        for (const group of names) {
          if (this.#client === undefined) return
          const removed = await this.#script(
            'remove idle consumers',
            REAP,
            [stream],
            [group, this.#reapIdleMs, `${this.#consumerBase}-`],
          )
          if (removed > 0) {
            this.#logger.debug(`Redis: removed ${removed} idle consumer(s) from group "${group}" of "${stream}"`)
          }
        }
      }
      for (const stream of trimmed) {
        let count = TRIM_BATCH
        while (count >= TRIM_BATCH && this.#client !== undefined) {
          count = await this.#script('trim a stream', TRIM, [stream], [TRIM_BATCH])
        }
      }
      this.#housekeepingFailing = false
    } catch (error) {
      if (this.#client === undefined) return
      const log = this.#housekeepingFailing ? this.#logger.debug : this.#logger.warn
      this.#housekeepingFailing = true
      log.call(this.#logger, 'Redis: the stream housekeeping failed, retrying', { err: error })
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Publishing
  // -----------------------------------------------------------------------------------------------

  async publish(queue: string, message: OutboundMessage): Promise<void> {
    const stream = this.#key(queue)
    const fields = encodeMessage(message)
    if (message.delayMs > 0) {
      this.#watch(stream, this.#maxLength)
      await this.#script(
        `publish to "${queue}"`,
        SCHEDULE,
        [`${stream}:delayed`, stream],
        [Math.ceil(message.delayMs), '', '', randomUUID(), ...fields],
      )
    } else {
      const trim = this.#maxLength === '0' ? [] : ['MAXLEN', '~', this.#maxLength]
      await this.#main(`publish to "${queue}"`).call('XADD', stream, ...trim, '*', ...fields)
    }
    await this.#confirm()
  }

  // -----------------------------------------------------------------------------------------------
  // Subscribing
  // -----------------------------------------------------------------------------------------------

  async subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    const client = this.#main(`subscribe to "${queue}"`)
    const group = this.#consumerGroup(options)
    const stream = this.#key(queue)
    const retry = `${stream}:retry:${group}`
    await this.#createGroup(client, queue, stream, group, 'the key')
    await this.#createGroup(client, queue, retry, group, 'its retry stream')
    await this.#checkType(client, queue, `${stream}:delayed`, 'zset', 'its delayed set')
    await this.#checkType(client, queue, `${retry}:delayed`, 'zset', 'its delayed retry set')
    if (options.deadLetterQueue !== undefined) {
      await this.#checkType(
        client,
        queue,
        this.#key(options.deadLetterQueue),
        'stream',
        `its dead-letter stream "${options.deadLetterQueue}"`,
      )
    }
    const blocking = client.duplicate()
    const state = (key: string): StreamState => ({ key, leased: new Set(), claimAt: 0, claimCursor: '0-0' })
    const subscription: StreamSubscription = {
      queue,
      main: state(stream),
      retry: state(retry),
      group,
      consumer: `${this.#consumerBase}-${++this.#consumers}`,
      handler,
      options,
      blocking,
      abort: new AbortController(),
      backlog: [],
      handling: new Set(),
      clientId: undefined,
      clientIdRefused: false,
      inflight: 0,
      active: true,
      wake: undefined,
      loop: undefined,
      heartbeat: undefined,
      closed: undefined,
    }
    // a reconnected connection has another CLIENT ID (read again before the next blocking read): never
    // unblock a stale one, which may belong to another client
    blocking.on('close', () => {
      subscription.clientId = undefined
    })
    this.#subscriptions.add(subscription)
    this.#watch(stream, this.#maxLength)
    this.#watch(retry, '0')
    subscription.heartbeat = setInterval(() => this.#keepClaimed(subscription), Math.max(1, this.#claimIdleMs / 3))
    subscription.heartbeat.unref?.()
    subscription.loop = this.#consume(subscription)
    return {
      cancel: () => this.#cancel(subscription),
      close: () => this.#close(subscription),
    }
  }

  #consumerGroup(options: SubscribeOptions): string {
    const value = options.options['group']
    if (value === undefined) return this.#group
    if (typeof value !== 'string' || value === '') {
      throw consumerError(
        `${options.consumer}: the Redis option group must be a non-empty string, got ${String(value)}`,
      )
    }
    return value
  }

  async #createGroup(client: Redis, queue: string, stream: string, group: string, label: string): Promise<void> {
    try {
      await client.call('XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM')
      this.#logger.debug(`Redis: created consumer group "${group}" on "${stream}"`)
    } catch (error) {
      const message = errorMessage(error)
      if (message.startsWith('BUSYGROUP')) return
      if (message.startsWith('WRONGTYPE')) {
        throw consumerError(`Redis: the key "${stream}" (${label} of queue "${queue}") is not a stream`, [
          'Use another queue name, or another prefix: redis({ prefix })',
        ])
      }
      throw brokerUnavailableError(`Redis: cannot create the consumer group of "${queue}" (${message})`, error)
    }
  }

  async #checkType(client: Redis, queue: string, key: string, expected: string, label: string): Promise<void> {
    let type: string
    try {
      type = String(await client.call('TYPE', key))
    } catch (error) {
      throw brokerUnavailableError(`Redis: cannot check ${label} of queue "${queue}"`, error)
    }
    if (type !== 'none' && type !== expected) {
      throw consumerError(`Redis: the key "${key}" (${label} of queue "${queue}") holds a ${type}, not a ${expected}`, [
        `Delete or rename "${key}", or use another prefix: redis({ prefix })`,
      ])
    }
  }

  #stop(subscription: StreamSubscription): void {
    subscription.active = false
    subscription.abort.abort()
    subscription.wake?.()
  }

  async #cancel(subscription: StreamSubscription): Promise<void> {
    this.#stop(subscription)
    const loop = subscription.loop
    if (loop === undefined) return
    let done = false
    void loop.finally(() => {
      done = true
    })
    // CLIENT UNBLOCK answers the blocking read at once (a nil reply: nothing is lost); repeated in
    // case the read reached the server after the first one. Without a known CLIENT ID (refused, or a
    // read resent after a reconnection), the read ends within blockMs.
    while (!done && subscription.clientId !== undefined && this.#client !== undefined) {
      try {
        await this.#client.call('CLIENT', 'UNBLOCK', subscription.clientId)
      } catch (error) {
        this.#logger.debug('Redis: CLIENT UNBLOCK failed, waiting for the blocking read to time out', { err: error })
        break
      }
      await Promise.race([loop, sleep(50)])
    }
    await loop
  }

  #close(subscription: StreamSubscription): Promise<void> {
    subscription.closed ??= (async () => {
      await this.#cancel(subscription)
      this.#subscriptions.delete(subscription)
      while (subscription.handling.size > 0) await Promise.allSettled([...subscription.handling])
      if (subscription.heartbeat !== undefined) clearInterval(subscription.heartbeat)
      subscription.heartbeat = undefined
      if (this.#client !== undefined) {
        try {
          await this.#script(
            'retire a consumer',
            RETIRE,
            [subscription.main.key, subscription.retry.key],
            [subscription.group, subscription.consumer],
          )
        } catch (error) {
          this.#logger.debug(`Redis: cannot remove consumer ${subscription.consumer} from its group`, { err: error })
        }
      }
      await quit(subscription.blocking)
    })()
    return subscription.closed
  }

  /** Resets the idle time of the entries read and not settled, so that no other member claims them. */
  #keepClaimed(subscription: StreamSubscription): void {
    const client = this.#client
    if (client === undefined) return
    for (const state of [subscription.main, subscription.retry]) {
      if (state.leased.size === 0) continue
      const ids = [...state.leased]
      client
        .call('XCLAIM', state.key, subscription.group, subscription.consumer, 0, ...ids, 'JUSTID')
        .catch((error: unknown) => {
          this.#logger.warn(`Redis: failed to keep ${ids.length} in-flight message(s) of "${state.key}" claimed`, {
            err: error,
          })
        })
    }
  }

  async #consume(subscription: StreamSubscription): Promise<void> {
    const { options, backlog } = subscription
    const signal = subscription.abort.signal
    let errorDelay = this.#readErrorDelayMs
    while (subscription.active) {
      const free = options.concurrency - subscription.inflight
      if (free <= 0) {
        await new Promise<void>(resolve => {
          subscription.wake = resolve
        })
        subscription.wake = undefined
        continue
      }
      if (backlog.length > 0) {
        for (const item of backlog.splice(0, free)) this.#deliver(subscription, item)
        continue
      }
      let received: Received[]
      try {
        received = await this.#claimDue(subscription, free)
        if (received.length === 0 && subscription.active) received = await this.#read(subscription, free)
        errorDelay = this.#readErrorDelayMs
      } catch (error) {
        if (!subscription.active) break
        this.#logger.warn(`Redis: reading "${subscription.queue}" failed, retrying in ${errorDelay} ms`, { err: error })
        try {
          await sleep(errorDelay, signal)
        } catch {
          break
        }
        errorDelay = Math.min(errorDelay * 2, MAX_ERROR_DELAY_MS)
        continue
      }
      for (const item of received) {
        if (!subscription.active) this.#releaseUnhandled(subscription, item)
        else if (subscription.inflight < options.concurrency) this.#deliver(subscription, item)
        else {
          // the queue stream and the retry stream each returned up to COUNT entries: the extra ones
          // wait here, kept claimed, for a free slot
          item.state.leased.add(item.entry.id)
          backlog.push(item)
        }
      }
    }
    for (const item of backlog.splice(0)) this.#releaseUnhandled(subscription, item)
  }

  /** Reads new entries of the queue stream and of the retry stream of the group. */
  async #read(subscription: StreamSubscription, count: number): Promise<Received[]> {
    const { blocking } = subscription
    if (subscription.clientId === undefined && !subscription.clientIdRefused) {
      try {
        subscription.clientId = Number(await blocking.call('CLIENT', 'ID'))
      } catch (error) {
        if (!isReplyError(error)) throw error
        // refused (ACL): stopping waits for the blocking read to time out
        subscription.clientIdRefused = true
        this.#logger.debug(`Redis: CLIENT ID failed on the reading connection of "${subscription.queue}"`, {
          err: error,
        })
      }
      if (!subscription.active) return []
    }
    const { main, retry } = subscription
    const reply = await blocking.callBuffer(
      'XREADGROUP',
      'GROUP',
      subscription.group,
      subscription.consumer,
      'COUNT',
      count,
      'BLOCK',
      this.#blockMs,
      'STREAMS',
      main.key,
      retry.key,
      '>',
      '>',
    )
    const received: Received[] = []
    for (const entry of parseRead(reply)) {
      received.push({ state: entry.stream === retry.key ? retry : main, entry, deliveries: 1 })
    }
    return received
  }

  /** Claims, on the streams whose claim pass is due, the entries left pending by crashed members. */
  async #claimDue(subscription: StreamSubscription, count: number): Promise<Received[]> {
    const received: Received[] = []
    for (const state of [subscription.main, subscription.retry]) {
      if (received.length >= count || !subscription.active) break
      if (Date.now() < state.claimAt) continue
      received.push(...(await this.#claim(subscription, state, count - received.length)))
    }
    return received
  }

  /** Claims entries left pending by crashed members (`XAUTOCLAIM`), with their delivery counts. */
  async #claim(subscription: StreamSubscription, state: StreamState, count: number): Promise<Received[]> {
    const client = this.#main(`claim pending messages of "${subscription.queue}"`)
    const reply = await client.callBuffer(
      'XAUTOCLAIM',
      state.key,
      subscription.group,
      subscription.consumer,
      Math.round(this.#claimIdleMs),
      state.claimCursor,
      'COUNT',
      count,
    )
    // Redis 7.0+: entries deleted while pending are dropped from the pending list (third element)
    const [cursor, raw] = Array.isArray(reply) ? reply : []
    const next = cursor === undefined || cursor === null ? '0-0' : text(cursor)
    state.claimCursor = next
    if (next === '0-0') state.claimAt = Date.now() + Math.max(1, this.#claimIdleMs / 2)
    const entries = Array.isArray(raw)
      ? raw.map(item => parseEntry(item, state.key)).filter(entry => entry !== undefined)
      : []
    if (entries.length === 0) return []
    const pending = (await client.call(
      'XPENDING',
      state.key,
      subscription.group,
      entries[0]?.id ?? '-',
      entries.at(-1)?.id ?? '+',
      entries.length + subscription.options.concurrency + state.leased.size,
      subscription.consumer,
    )) as unknown
    const counts = new Map<string, number>()
    if (Array.isArray(pending)) {
      for (const item of pending) {
        if (Array.isArray(item)) counts.set(text(item[0]), Number(item[3]))
      }
    }
    return entries.map(entry => ({ state, entry, deliveries: Math.max(2, counts.get(entry.id) ?? 2) }))
  }

  /** Gives back an entry read while stopping (never handed to the runtime) to the retry stream of the group. */
  #releaseUnhandled(subscription: StreamSubscription, item: Received): void {
    const { entry, deliveries, state } = item
    const decoded = decode(entry)
    const attempt = attemptFromHeaders(decoded.headers) + deliveries - 1
    const headers = headerRecord()
    Object.assign(headers, decoded.headers)
    headers[MessagingHeaders.Attempt] = String(attempt)
    const released = this.#move(subscription, entry, subscription.retry.key, '0', decoded, headers)
      .catch((error: unknown) => {
        this.#logger.debug(
          `Redis: failed to give back entry ${entry.id} of "${subscription.queue}" read while stopping (claimed back later)`,
          { err: error },
        )
      })
      .finally(() => {
        state.leased.delete(entry.id)
        subscription.handling.delete(released)
      })
    subscription.handling.add(released)
  }

  /** Adds a copy of `entry` to `target` and acknowledges the original, in one script. */
  async #move(
    subscription: StreamSubscription,
    entry: Entry,
    target: string,
    maxLength: string,
    decoded: Decoded,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#script(
      `settle a message of "${subscription.queue}"`,
      MOVE,
      [target, entry.stream],
      [maxLength, subscription.group, entry.id, ...encodeFields(decoded, headers)],
    )
    await this.#confirm()
  }

  #deliver(subscription: StreamSubscription, item: Received): void {
    const { entry, deliveries, state } = item
    const decoded = decode(entry)
    const headers = decoded.headers
    const attempt = attemptFromHeaders(headers) + deliveries - 1
    const { group } = subscription
    const retryStream = subscription.retry.key
    subscription.inflight++
    state.leased.add(entry.id)
    let settled = false
    const settle = async (action: string, run: () => Promise<void>): Promise<void> => {
      if (settled) throw new Error(`[redis] message ${decoded.id} was already settled (${action})`)
      await run()
      settled = true
      state.leased.delete(entry.id)
    }
    const withAttempt = (value: number): Record<string, string> => {
      const result = headerRecord()
      Object.assign(result, headers)
      result[MessagingHeaders.Attempt] = String(value)
      return result
    }
    const fields = headerRecord() as unknown as Record<string, Uint8Array>
    for (const [name, value] of entry.fields) fields[name] = value
    const raw: RedisStreamEntry = {
      stream: entry.stream,
      group,
      consumer: subscription.consumer,
      id: entry.id,
      deliveries,
      fields,
    }
    const acknowledge = async (): Promise<void> => {
      await this.#main('acknowledge a message').call('XACK', entry.stream, group, entry.id)
      await this.#confirm()
    }
    const delivery: DriverDelivery = {
      id: decoded.id,
      body: decoded.body,
      contentType: decoded.contentType,
      headers,
      type: decoded.type,
      key: decoded.key,
      attempt,
      redelivered: attempt > 1 || deliveries > 1,
      timestamp: decoded.timestamp,
      raw,
      ack: (): Promise<void> => settle('ack', acknowledge),
      // retry and release copies go to the retry stream of the group: the other groups of the queue
      // stream (a fan-out) never see them
      release: (): Promise<void> =>
        settle('release', () => this.#move(subscription, entry, retryStream, '0', decoded, withAttempt(attempt))),
      retry: (request: RetryRequest): Promise<void> =>
        settle('retry', async () => {
          const copy = withAttempt(request.attempt)
          if (request.delayMs <= 0) return this.#move(subscription, entry, retryStream, '0', decoded, copy)
          await this.#script(
            `retry a message of "${subscription.queue}"`,
            SCHEDULE,
            [`${retryStream}:delayed`, entry.stream],
            [Math.ceil(request.delayMs), group, entry.id, randomUUID(), ...encodeFields(decoded, copy)],
          )
          await this.#confirm()
        }),
      deadLetter: (request: DeadLetterRequest): Promise<void> =>
        settle('dead-letter', () => {
          // Redis has no dead-letter policy of its own: without a Znight dead letter, the message is dropped
          if (request.queue === undefined) return acknowledge()
          const copy = deadLetterHeaders(headers, request, subscription.queue)
          return this.#move(subscription, entry, this.#key(request.queue), this.#deadLetterMaxLength, decoded, copy)
        }),
    }
    const handled = subscription
      .handler(delivery)
      .catch((error: unknown) => {
        this.#logger.error(`Redis: unexpected failure handling message ${decoded.id}`, { err: error })
      })
      .finally(() => {
        subscription.handling.delete(handled)
        state.leased.delete(entry.id)
        subscription.inflight--
        subscription.wake?.()
      })
    subscription.handling.add(handled)
  }
}

function lengthOption(value: number | undefined, name: string): string {
  if (value === undefined) return '0'
  if (!(Number.isSafeInteger(value) && value >= 1)) {
    throw new TypeError(`[znight] redis(): ${name} must be an integer >= 1, got ${String(value)}`)
  }
  return String(value)
}

async function quit(client: Redis): Promise<void> {
  try {
    await client.quit()
  } catch {
    client.disconnect()
  }
}

function text(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return String(value)
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return Buffer.from(String(value))
}

/** The fields of a published message. */
function encodeMessage(message: OutboundMessage): Argument[] {
  const fields: Argument[] = [RedisStreamFields.Id, message.id]
  if (message.type !== undefined) fields.push(RedisStreamFields.Type, message.type)
  if (message.key !== undefined) fields.push(RedisStreamFields.Key, message.key)
  fields.push(RedisStreamFields.ContentType, message.contentType)
  fields.push(RedisStreamFields.Timestamp, String(message.timestamp))
  for (const [name, value] of Object.entries(message.headers))
    fields.push(`${RedisStreamFields.HeaderPrefix}${name}`, value)
  fields.push(RedisStreamFields.Body, toBuffer(bodyToBytes(message.body)))
  return fields
}

/** The fields of a copy of a received entry, with `headers`. */
function encodeFields(decoded: Decoded, headers: Readonly<Record<string, string>>): Argument[] {
  const fields: Argument[] = [RedisStreamFields.Id, decoded.id]
  if (decoded.type !== undefined) fields.push(RedisStreamFields.Type, decoded.type)
  if (decoded.key !== undefined) fields.push(RedisStreamFields.Key, decoded.key)
  if (decoded.contentType !== undefined) fields.push(RedisStreamFields.ContentType, decoded.contentType)
  if (decoded.timestamp !== undefined) fields.push(RedisStreamFields.Timestamp, String(decoded.timestamp))
  for (const [name, value] of Object.entries(headers)) fields.push(`${RedisStreamFields.HeaderPrefix}${name}`, value)
  fields.push(RedisStreamFields.Body, toBuffer(decoded.body))
  return fields
}

function decode(entry: Entry): Decoded {
  let id: string | undefined
  let type: string | undefined
  let key: string | undefined
  let contentType: string | undefined
  let timestamp: number | undefined
  let body: Uint8Array = EMPTY
  const headers = headerRecord()
  const foreign = headerRecord()
  for (const [name, value] of entry.fields) {
    switch (name) {
      case RedisStreamFields.Body:
        body = value
        break
      case RedisStreamFields.Id:
        id = text(value)
        break
      case RedisStreamFields.Type:
        type = text(value)
        break
      case RedisStreamFields.Key:
        key = text(value)
        break
      case RedisStreamFields.ContentType:
        contentType = text(value)
        break
      case RedisStreamFields.Timestamp: {
        const time = Number(text(value))
        if (Number.isFinite(time) && time > 0) timestamp = time
        break
      }
      default:
        if (name.startsWith(RedisStreamFields.HeaderPrefix)) {
          if (name.length > RedisStreamFields.HeaderPrefix.length) {
            headers[name.slice(RedisStreamFields.HeaderPrefix.length)] = text(value)
          }
        } else if (!TRANSPORT_FIELDS.has(name)) foreign[name] = text(value)
    }
  }
  for (const [name, value] of Object.entries(foreign)) if (!Object.hasOwn(headers, name)) headers[name] = value
  if (timestamp === undefined) {
    const time = Number(entry.id.split('-', 1)[0])
    if (Number.isFinite(time) && time > 0) timestamp = time
  }
  return { id: id ?? entry.id, type, key, contentType, timestamp, headers, body }
}

function parseEntry(raw: unknown, stream: string): Entry | undefined {
  if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) return undefined
  const values = raw[1] as unknown[]
  const fields: [string, Buffer][] = []
  for (let index = 0; index + 1 < values.length; index += 2) {
    fields.push([text(values[index]), toBuffer(values[index + 1])])
  }
  return { stream, id: text(raw[0]), fields }
}

/**
 * The entries of an `XREADGROUP` reply, with their stream: RESP2 (`[[stream, entries], ...]`), or a
 * RESP3 map as ioredis returns it from `callBuffer` (flattened `[stream, entries, ...]`, a `Map` or an
 * object).
 */
function parseRead(reply: unknown): Entry[] {
  if (reply === null || reply === undefined) return []
  let streams: (readonly [unknown, unknown])[]
  if (Array.isArray(reply)) {
    if (Array.isArray(reply[0])) {
      streams = reply.map(item =>
        Array.isArray(item) ? ([item[0], item[1]] as const) : ([undefined, undefined] as const),
      )
    } else {
      streams = []
      for (let index = 0; index + 1 < reply.length; index += 2) streams.push([reply[index], reply[index + 1]])
    }
  } else if (reply instanceof Map) streams = [...reply.entries()]
  else if (typeof reply === 'object') streams = Object.entries(reply)
  else streams = []
  const entries: Entry[] = []
  for (const [key, list] of streams) {
    if (!Array.isArray(list)) continue
    const stream = text(key)
    for (const raw of list) {
      const entry = parseEntry(raw, stream)
      if (entry !== undefined) entries.push(entry)
    }
  }
  return entries
}

/** A Redis error reply (ioredis `ReplyError`), as opposed to a connection failure. */
function isReplyError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ReplyError'
}
