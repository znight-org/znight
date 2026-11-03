/**
 * Options of `GraphQLPlugin` (RFC 0005 §5.11): their types, defaults and validation (ZNIGHT066).
 */
import type { ByteSize, GuardRef, RouteMetaEntry } from '@znight/http'
import type { SubscribeOptions } from './pubsub.ts'
import type { GraphQLErrorMapper, GraphQLErrorMapperClass, GraphQLGuard, GraphQLGuardClass } from './types.ts'

import { ErrorCode, ZnightError } from '@znight/core'
import { parseByteSize } from '@znight/http'

/**
 * A `PubSub` of any event map, for the `pubsub` option: `PubSub<Events>` types are not assignable
 * to each other (generic methods over `keyof Events`), so the option accepts the structure.
 */
export interface AnyPubSub {
  publish(topic: never, payload: never): Promise<void>
  subscribe(topic: never, options?: SubscribeOptions): AsyncIterableIterator<unknown>
}

/** A global GraphQL guard: a provider class or an instance. */
export type GraphQLGuardRef = GraphQLGuardClass | GraphQLGuard

/** An error mapper: a provider class or an instance. */
export type GraphQLErrorMapperRef = GraphQLErrorMapperClass | GraphQLErrorMapper

/** Options of the GraphQL-over-HTTP endpoint. */
export interface GraphQLHttpOptions {
  /** Route metadata of the endpoint (`[Public.meta()]`), seen by HTTP guards and the route decision check. */
  readonly meta?: readonly RouteMetaEntry[]
  /** Guards of the endpoint (HTTP `CanActivate`), after the global `HttpPlugin` guards. */
  readonly guards?: readonly GuardRef[]
  /** Body limit of the endpoint. Default `'100kb'`. */
  readonly bodyLimit?: ByteSize
  /** Queries over `GET`. Default `true`. */
  readonly get?: boolean
}

/** Request limits; `false` disables one. */
export interface GraphQLLimits {
  /** Tokens of a document (`parse`). Default 2 000. */
  readonly maxTokens?: number | false
  /** Field nesting of an operation (introspection fields exempt). Default 12. */
  readonly maxDepth?: number | false
  /**
   * Aliases of a document, as written and as one operation executes them (a fragment spread several
   * times counts each time). Default 30.
   */
  readonly maxAliases?: number | false
  /** Directives of a document. Default 50. */
  readonly maxDirectives?: number | false
}

/** Subscription options. */
export interface GraphQLSubscriptionOptions {
  /** Active subscriptions cap (every transport); beyond it, 503. Default 10 000. */
  readonly maxActive?: number
  /** Events buffered per subscriber by the default `MemoryPubSub`. Default 100. */
  readonly bufferSize?: number
  /** SSE heartbeat (ms), `false` for none. Default: the `HttpPlugin` `sse` option. */
  readonly heartbeat?: number | false
  /** SSE maximum duration (ms). Default: none. */
  readonly maxDuration?: number
}

/** Options of `GraphQLPlugin.configure()`. */
export interface GraphQLPluginOptions {
  /** Path of the endpoint, joined with the `HttpPlugin` prefix. Default `'/graphql'`. */
  readonly path?: string
  /** `false`: no HTTP transport (schema, `execute()` and `subscribe()` only). Default `{}`. */
  readonly http?: GraphQLHttpOptions | false
  /** Global GraphQL guards (classes or instances): root fields, and field resolvers with metadata. */
  readonly guards?: readonly GraphQLGuardRef[]
  /** Error mappers (classes or instances), tried in order. */
  readonly errorMappers?: readonly GraphQLErrorMapperRef[]
  /** Unmasked messages for unexpected errors (development). Default `false`. */
  readonly exposeErrors?: boolean
  /** Introspection; off, suggestions are hidden too. Default `NODE_ENV !== 'production'`. */
  readonly introspection?: boolean
  /** GraphiQL on `GET path` with `accept: text/html`. Default `NODE_ENV === 'development'`. */
  readonly graphiql?: boolean
  readonly limits?: GraphQLLimits
  /** Distinct documents kept parsed and validated (LRU); 0 disables the cache. Default 1 000. */
  readonly documentCache?: number
  /** `false` disables subscriptions over SSE. */
  readonly subscriptions?: GraphQLSubscriptionOptions | false
  /** The `PubSub` provided to the container. Default: a `MemoryPubSub` (closed with the application). */
  readonly pubsub?: AnyPubSub
  /**
   * How the boot check of route decisions on GraphQL fields (RFC 0001, ZNIGHT023) reports problems:
   * `'error'` (default) fails the boot, `'warn'` logs.
   */
  readonly enforcement?: 'error' | 'warn'
}

/** Options with their defaults, validated. */
export interface ResolvedGraphQLOptions {
  readonly path: string
  readonly http: Required<GraphQLHttpOptions> | false
  readonly guards: readonly GraphQLGuardRef[]
  readonly errorMappers: readonly GraphQLErrorMapperRef[]
  readonly exposeErrors: boolean
  readonly introspection: boolean
  readonly graphiql: boolean
  readonly limits: {
    readonly maxTokens: number | undefined
    readonly maxDepth: number | undefined
    readonly maxAliases: number | undefined
    readonly maxDirectives: number | undefined
  }
  readonly documentCache: number
  readonly subscriptions:
    | {
        readonly maxActive: number
        readonly bufferSize: number
        readonly heartbeat: number | false | undefined
        readonly maxDuration: number | undefined
      }
    | false
  readonly bufferSize: number
  readonly pubsub: AnyPubSub | undefined
  readonly enforcement: 'error' | 'warn'
}

const KEYS: ReadonlySet<string> = new Set([
  'path',
  'http',
  'guards',
  'errorMappers',
  'exposeErrors',
  'introspection',
  'graphiql',
  'limits',
  'documentCache',
  'subscriptions',
  'pubsub',
  'enforcement',
])
const PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/]*$/
const LIMIT_DEFAULTS = { maxTokens: 2000, maxDepth: 12, maxAliases: 30, maxDirectives: 50 } as const

function show(value: unknown): string {
  if (typeof value === 'function') return 'a function'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return typeof value
  }
}

/** ZNIGHT066 for an invalid option. */
export function invalidOption(name: string, expected: string, received: unknown): ZnightError {
  return new ZnightError(
    ErrorCode.InvalidGraphQLSetup,
    `GraphQLPlugin: invalid option ${name}: expected ${expected} (received ${show(received)})`,
    { hints: ['See the options of GraphQLPlugin.configure() (RFC 0005 §5.11)'] },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boolean(name: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalidOption(name, 'a boolean', value)
  return value
}

function positiveInteger(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (!(Number.isSafeInteger(value) && (value as number) >= 1)) throw invalidOption(name, 'a positive integer', value)
  return value as number
}

function limit(name: keyof typeof LIMIT_DEFAULTS, value: unknown): number | undefined {
  if (value === false) return undefined
  return positiveInteger(`limits.${name}`, value, LIMIT_DEFAULTS[name])
}

/** Refs given as classes or instances with `method`. */
function refs<T>(name: string, value: unknown, method: string): readonly T[] {
  if (value === undefined) return []
  if (!Array.isArray(value))
    throw invalidOption(name, `an array of classes or objects with a ${method}() method`, value)
  for (const ref of value) {
    const ok =
      typeof ref === 'function' ||
      (ref !== null && typeof ref === 'object' && typeof (ref as Record<string, unknown>)[method] === 'function')
    if (!ok) throw invalidOption(name, `classes or objects with a ${method}() method`, ref)
  }
  return value as readonly T[]
}

/** Validates the options and applies the defaults (`env`: `process.env`). */
export function resolveGraphQLOptions(
  options: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedGraphQLOptions {
  if (!isRecord(options)) throw invalidOption('options', 'an object', options)
  for (const key of Object.keys(options)) {
    if (!KEYS.has(key)) throw invalidOption(key, `one of ${[...KEYS].join(', ')}`, key)
  }
  const nodeEnv = env['NODE_ENV']
  const path = options['path'] ?? '/graphql'
  if (typeof path !== 'string' || !PATH.test(path)) throw invalidOption('path', "a path starting with '/'", path)

  const rawHttp = options['http'] ?? {}
  let http: ResolvedGraphQLOptions['http']
  if (rawHttp === false) {
    http = false
  } else {
    if (!isRecord(rawHttp)) throw invalidOption('http', 'false or { meta?, guards?, bodyLimit?, get? }', rawHttp)
    const meta = rawHttp['meta'] ?? []
    if (
      !Array.isArray(meta) ||
      !meta.every(entry => isRecord(entry) && typeof entry['key'] === 'string' && entry['key'] !== '')
    ) {
      throw invalidOption('http.meta', 'an array of route metadata entries (Decorator.meta())', meta)
    }
    const bodyLimit = rawHttp['bodyLimit'] ?? '100kb'
    if (parseByteSize(bodyLimit) === undefined)
      throw invalidOption('http.bodyLimit', "a byte size ('100kb', 1048576)", bodyLimit)
    http = {
      meta: meta as readonly RouteMetaEntry[],
      guards: refs<GuardRef>('http.guards', rawHttp['guards'], 'canActivate'),
      bodyLimit: bodyLimit as ByteSize,
      get: boolean('http.get', rawHttp['get'], true),
    }
  }

  const rawLimits = options['limits'] ?? {}
  if (!isRecord(rawLimits))
    throw invalidOption('limits', '{ maxTokens?, maxDepth?, maxAliases?, maxDirectives? }', rawLimits)
  for (const key of Object.keys(rawLimits)) {
    if (!(key in LIMIT_DEFAULTS))
      throw invalidOption(`limits.${key}`, 'maxTokens, maxDepth, maxAliases or maxDirectives', key)
  }

  const documentCache = options['documentCache'] ?? 1000
  if (!(Number.isSafeInteger(documentCache) && (documentCache as number) >= 0)) {
    throw invalidOption('documentCache', 'a non-negative integer', documentCache)
  }

  const rawSubscriptions = options['subscriptions'] ?? {}
  let subscriptions: ResolvedGraphQLOptions['subscriptions']
  let bufferSize = 100
  if (rawSubscriptions === false) {
    subscriptions = false
  } else {
    if (!isRecord(rawSubscriptions)) {
      throw invalidOption(
        'subscriptions',
        'false or { maxActive?, bufferSize?, heartbeat?, maxDuration? }',
        rawSubscriptions,
      )
    }
    bufferSize = positiveInteger('subscriptions.bufferSize', rawSubscriptions['bufferSize'], 100)
    const heartbeat = rawSubscriptions['heartbeat']
    if (heartbeat !== undefined && heartbeat !== false && !(typeof heartbeat === 'number' && heartbeat > 0)) {
      throw invalidOption('subscriptions.heartbeat', 'a positive number of milliseconds or false', heartbeat)
    }
    const maxDuration = rawSubscriptions['maxDuration']
    if (maxDuration !== undefined && !(typeof maxDuration === 'number' && maxDuration > 0)) {
      throw invalidOption('subscriptions.maxDuration', 'a positive number of milliseconds', maxDuration)
    }
    subscriptions = {
      maxActive: positiveInteger('subscriptions.maxActive', rawSubscriptions['maxActive'], 10_000),
      bufferSize,
      heartbeat: heartbeat as number | false | undefined,
      maxDuration: maxDuration as number | undefined,
    }
  }

  const pubsub = options['pubsub']
  if (
    pubsub !== undefined &&
    !(
      isRecord(pubsub) &&
      typeof (pubsub as { publish?: unknown }).publish === 'function' &&
      typeof (pubsub as { subscribe?: unknown }).subscribe === 'function'
    )
  ) {
    throw invalidOption('pubsub', 'a PubSub (publish() and subscribe() methods)', pubsub)
  }
  const enforcement = options['enforcement'] ?? 'error'
  if (enforcement !== 'error' && enforcement !== 'warn')
    throw invalidOption('enforcement', "'error' or 'warn'", enforcement)

  return {
    path,
    http,
    guards: refs<GraphQLGuardRef>('guards', options['guards'], 'canResolve'),
    errorMappers: refs<GraphQLErrorMapperRef>('errorMappers', options['errorMappers'], 'map'),
    exposeErrors: boolean('exposeErrors', options['exposeErrors'], false),
    introspection: boolean('introspection', options['introspection'], nodeEnv !== 'production'),
    graphiql: boolean('graphiql', options['graphiql'], nodeEnv === 'development'),
    limits: {
      maxTokens: limit('maxTokens', rawLimits['maxTokens']),
      maxDepth: limit('maxDepth', rawLimits['maxDepth']),
      maxAliases: limit('maxAliases', rawLimits['maxAliases']),
      maxDirectives: limit('maxDirectives', rawLimits['maxDirectives']),
    },
    documentCache: documentCache as number,
    subscriptions,
    bufferSize,
    pubsub: pubsub as AnyPubSub | undefined,
    enforcement,
  }
}
