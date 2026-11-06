/**
 * Structural readers of the feature metadata (`metadata.extensions`). `@znight/testing` depends on
 * no feature package: it reads the documented shapes (architecture §9, RFC 0005 §7.1 for
 * `extensions.graphql`) defensively and ignores malformed entries.
 */
import type { Token, ZnightMetadata } from '@znight/core'

/** A configuration class (`metadata.extensions.config.configs[]`), as far as tests need it. */
export interface ConfigClassInfo {
  readonly token: Token
  readonly prefix: string | undefined
  readonly fields: readonly ConfigFieldInfo[]
}

/** A field of a configuration class. */
export interface ConfigFieldInfo {
  readonly property: string
  readonly env: string | undefined
  /** Config type (`'string'`, `'number'`, `'url'`...), `undefined` when absent from the metadata. */
  readonly type: string | undefined
  /** Whether the field declares a default value (`@Default`; initializers are not in the metadata). */
  readonly hasDefault: boolean
  readonly default: unknown
  readonly required: boolean
}

type Loose = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Loose {
  return value !== null && typeof value === 'object'
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function extension(metadata: ZnightMetadata, name: string): Loose | undefined {
  if (!isRecord(metadata)) return undefined
  const extensions: unknown = metadata.extensions
  if (!isRecord(extensions)) return undefined
  const value = extensions[name]
  return isRecord(value) ? value : undefined
}

function tokensOf(value: unknown): Token[] {
  return arrayOf(value).filter((token): token is Token => typeof token === 'string')
}

/** Configuration classes declared by `@znight/config` (`extensions.config.configs`), by token. */
export function readConfigClasses(metadata: ZnightMetadata): Map<Token, ConfigClassInfo> {
  const result = new Map<Token, ConfigClassInfo>()
  for (const entry of arrayOf(extension(metadata, 'config')?.['configs'])) {
    if (!isRecord(entry) || typeof entry['token'] !== 'string') continue
    const fields: ConfigFieldInfo[] = []
    for (const field of arrayOf(entry['fields'])) {
      if (!isRecord(field) || typeof field['property'] !== 'string') continue
      fields.push({
        property: field['property'],
        env: typeof field['env'] === 'string' ? field['env'] : undefined,
        type: typeof field['type'] === 'string' ? field['type'] : undefined,
        hasDefault: Object.hasOwn(field, 'default') && field['default'] !== undefined,
        default: field['default'],
        required: field['required'] === true,
      })
    }
    const prefix = entry['prefix']
    result.set(entry['token'], {
      token: entry['token'],
      prefix: typeof prefix === 'string' && prefix !== '' ? prefix : undefined,
      fields,
    })
  }
  return result
}

/**
 * Tokens an HTTP application needs at boot: controllers (`extensions.http.controllers[].token`) and
 * the guards, interceptors and parameter resolvers (RFC 0010) they and their routes reference.
 */
export function readHttpRoots(metadata: ZnightMetadata): Token[] {
  const roots: Token[] = []
  for (const controller of arrayOf(extension(metadata, 'http')?.['controllers'])) {
    if (!isRecord(controller)) continue
    if (typeof controller['token'] === 'string') roots.push(controller['token'])
    roots.push(...tokensOf(controller['guards']), ...tokensOf(controller['interceptors']))
    for (const route of arrayOf(controller['routes'])) {
      if (isRecord(route)) {
        roots.push(
          ...tokensOf(route['guards']),
          ...tokensOf(route['interceptors']),
          ...tokensOf(route['paramResolvers']),
        )
      }
    }
  }
  return roots
}

/** Message consumers (`extensions.messaging.consumers[].token`) and their parameter resolvers (RFC 0010). */
export function readMessagingRoots(metadata: ZnightMetadata): Token[] {
  const roots: Token[] = []
  for (const consumer of arrayOf(extension(metadata, 'messaging')?.['consumers'])) {
    if (!isRecord(consumer)) continue
    if (typeof consumer['token'] === 'string') roots.push(consumer['token'])
    for (const handler of arrayOf(consumer['handlers'])) {
      if (isRecord(handler)) roots.push(...tokensOf(handler['paramResolvers']))
    }
  }
  return roots
}

/** Hosts of scheduled jobs (`extensions.schedule.jobs[].token`), disabled jobs included (they can be triggered). */
export function readScheduleRoots(metadata: ZnightMetadata): Token[] {
  const roots: Token[] = []
  for (const job of arrayOf(extension(metadata, 'schedule')?.['jobs'])) {
    if (isRecord(job) && typeof job['token'] === 'string') roots.push(job['token'])
  }
  return roots
}

/**
 * Tokens a GraphQL application needs at boot (`extensions.graphql`, RFC 0005 §7.1): for every field
 * of an object type bound to a resolver (`types[kind: 'object'].fields[].resolver`), the resolver
 * token, its guard tokens, the loader tokens its method injects and its parameter resolvers (RFC 0010).
 */
export function readGraphQLRoots(metadata: ZnightMetadata): Token[] {
  const roots: Token[] = []
  for (const type of arrayOf(extension(metadata, 'graphql')?.['types'])) {
    if (!isRecord(type) || type['kind'] !== 'object') continue
    for (const field of arrayOf(type['fields'])) {
      const resolver = isRecord(field) ? field['resolver'] : undefined
      if (!isRecord(resolver)) continue
      if (typeof resolver['token'] === 'string') roots.push(resolver['token'])
      roots.push(
        ...tokensOf(resolver['guards']),
        ...tokensOf(resolver['loaders']),
        ...tokensOf(resolver['paramResolvers']),
      )
    }
  }
  return roots
}

/**
 * Tokens a WebSocket application needs at boot (`extensions.websocket`, RFC 0003 §7.1): every
 * gateway, its handshake and message guards and the guards of its handlers.
 */
export function readWebSocketRoots(metadata: ZnightMetadata): Token[] {
  const roots: Token[] = []
  for (const gateway of arrayOf(extension(metadata, 'websocket')?.['gateways'])) {
    if (!isRecord(gateway) || typeof gateway['token'] !== 'string') continue
    roots.push(gateway['token'], ...tokensOf(gateway['handshakeGuards']), ...tokensOf(gateway['messageGuards']))
    for (const handler of arrayOf(gateway['handlers'])) {
      if (isRecord(handler)) roots.push(...tokensOf(handler['guards']))
    }
  }
  return roots
}
