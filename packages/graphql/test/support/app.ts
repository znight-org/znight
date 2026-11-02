/**
 * Helpers of the runtime tests: hand-written `metadata.extensions.graphql` (the shape the compiler
 * generates), an application booted with `GraphQLPlugin`, and a capturing logger.
 */
import type {
  CoreLogger,
  ExternalDefinition,
  LogContext,
  Plugin,
  PluginOptions,
  ProviderClass,
  Token,
  ZnightMetadata,
} from '@znight/core'
import type { TestProvider } from '@znight/testing'
import type {
  GraphQLFieldDefinition,
  GraphQLMetadata,
  GraphQLPluginOptions,
  GraphQLResolverBinding,
  GraphQLRootTypes,
  GraphQLTypeDefinition,
} from '../../src/index.ts'

import { Application } from '@znight/core'
import { defineTestMetadata, testToken } from '@znight/testing'

import { GraphQLPlugin } from '../../src/index.ts'

/** Externals of the plugin (the manifest's `provides`). */
export const GRAPHQL_EXTERNALS: readonly ExternalDefinition[] = [
  { token: '@znight/graphql#GraphQLContext', scope: 'request', providedBy: 'GraphQLPlugin' },
  { token: '@znight/graphql#PubSub', providedBy: 'GraphQLPlugin' },
  { token: '@znight/graphql#GraphQLPlugin', providedBy: 'GraphQLPlugin' },
]

/** Options of {@link graphqlMetadata}. */
export interface GraphQLMetadataSpec {
  readonly providers?: readonly (TestProvider | ProviderClass)[]
  readonly types: readonly GraphQLTypeDefinition[]
  /** Default: `Query`, plus `Mutation` and `Subscription` when declared. */
  readonly roots?: GraphQLRootTypes
  readonly groups?: GraphQLMetadata['groups']
  readonly externals?: readonly (Token | ExternalDefinition)[]
}

/** Metadata with providers (tokens `test#ClassName`) and a hand-written graphql section (types sorted). */
export function graphqlMetadata(spec: GraphQLMetadataSpec): ZnightMetadata {
  const types = [...spec.types].sort((a, b) => (a.name < b.name ? -1 : 1))
  const names = new Set(types.map(type => type.name))
  const roots: GraphQLRootTypes = spec.roots ?? {
    query: 'Query',
    ...(names.has('Mutation') ? { mutation: 'Mutation' } : {}),
    ...(names.has('Subscription') ? { subscription: 'Subscription' } : {}),
  }
  const section: GraphQLMetadata = {
    version: 1,
    schemaHash: '0123456789abcdef',
    roots,
    types,
    ...(spec.groups === undefined ? {} : { groups: spec.groups }),
  }
  return defineTestMetadata({
    providers: spec.providers ?? [],
    externals: [...GRAPHQL_EXTERNALS, ...(spec.externals ?? [])],
    extensions: { graphql: section },
  })
}

/** Options of {@link bind}. */
export interface BindOptions {
  readonly operation?: GraphQLResolverBinding['operation']
  readonly guards?: readonly ProviderClass[]
  readonly meta?: Readonly<Record<string, unknown>>
  readonly loaders?: readonly Token[]
  /** Default: `(r, p, a, c, i) => r[method](a, p, c, i)`. */
  readonly invoke?: GraphQLResolverBinding['invoke']
}

/** A resolver binding of `cls.method`. */
export function bind(cls: ProviderClass, method: string, options: BindOptions = {}): GraphQLResolverBinding {
  return {
    token: testToken(cls),
    method,
    operation: options.operation ?? 'query',
    guards: (options.guards ?? []).map(guard => testToken(guard)),
    meta: options.meta ?? {},
    ...(options.loaders === undefined ? {} : { loaders: options.loaders }),
    invoke:
      options.invoke ??
      ((resolver: Record<string, (...args: unknown[]) => unknown>, parent, args, context, info) =>
        (resolver[method] as (...args: unknown[]) => unknown).call(resolver, args, parent, context, info)),
  }
}

/** A root field backed by `cls.method`. */
export function field(
  name: string,
  type: string,
  resolver?: GraphQLResolverBinding,
  extra: Partial<GraphQLFieldDefinition> = {},
): GraphQLFieldDefinition {
  return { name, type, ...extra, ...(resolver === undefined ? {} : { resolver }) }
}

/** A log entry captured by {@link captureLogger}. */
export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly context: LogContext | undefined
}

/** A logger recording every entry. */
export interface CapturedLogger extends CoreLogger {
  readonly entries: LogEntry[]
  messages(level?: LogEntry['level']): string[]
}

export function captureLogger(): CapturedLogger {
  const entries: LogEntry[] = []
  const log =
    (level: LogEntry['level']) =>
    (message: string, context?: LogContext): void => {
      entries.push({ level, message, context })
    }
  return {
    entries,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    messages: level =>
      entries.filter(entry => level === undefined || entry.level === level).map(entry => entry.message),
  }
}

/** An application booted with `GraphQLPlugin` (`http: false` unless the options say otherwise). */
export interface Booted extends AsyncDisposable {
  readonly app: Application
  readonly plugin: GraphQLPlugin
  readonly logs: CapturedLogger
}

/** Boots `metadata` with `GraphQLPlugin.configure({ http: false, ...options })`. */
export async function boot(
  metadata: ZnightMetadata,
  options: PluginOptions<GraphQLPluginOptions> = {},
  plugins: readonly Plugin[] = [],
): Promise<Booted> {
  const logs = captureLogger()
  const plugin = GraphQLPlugin.configure(
    typeof options === 'function' ? c => ({ http: false, ...options(c) }) : { http: false, ...options },
  )
  const app = await Application.create({
    metadata,
    plugins: [...plugins, plugin],
    logger: logs,
    shutdown: { signals: false },
  })
  return {
    app,
    plugin,
    logs,
    [Symbol.asyncDispose]: () => app.stop(),
  }
}

/** A deferred promise. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}
