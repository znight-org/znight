/**
 * Helpers of the runtime tests: hand-written metadata (one host class whose jobs call test functions),
 * an application booted with `SchedulePlugin` on a test clock, a capturing logger and deferred promises.
 */
import type {
  CoreLogger,
  LogContext,
  Plugin,
  PluginOptions,
  ProviderDefinition,
  Token,
  ZnightMetadata,
} from '@znight/core'
import type { JobContext } from '../src/context.ts'
import type { SchedulePluginInstance, SchedulePluginOptions } from '../src/index.ts'
import type { TestClock } from '../src/testing/index.ts'

import { Application } from '@znight/core'
import { createMetadata } from '@znight/testing'

import { SchedulePlugin, SchedulerRegistry } from '../src/index.ts'
import { createTestClock } from '../src/testing/index.ts'

/** The host class of the hand-written jobs. */
export class Host {}

/** Token of {@link Host}. */
export const HOST: Token = 'src/host.ts#Host'

/** A job definition of the metadata, with a function in place of a host method. */
export type JobSpec = { readonly name: string; readonly run?: (ctx: JobContext) => unknown } & (
  | { readonly kind: 'cron'; readonly cron: string; readonly timeZone?: string; readonly runOnStart?: true }
  | { readonly kind: 'interval'; readonly every: number; readonly runOnStart?: true }
  | { readonly kind: 'timeout'; readonly delay: number }
) & {
    readonly overlap?: 'queue' | 'allow'
    readonly lock?: boolean
    readonly maxDuration?: number
    readonly enabled?: false
    readonly token?: Token
    readonly method?: string
    /** The generated invoker (default: calls `run`). */
    readonly invoke?: (host: never, ctx: JobContext) => unknown
  }

/** The metadata section of `jobs` (sorted by name, like the compiler does). */
export function scheduleSection(jobs: readonly JobSpec[]): { jobs: Record<string, unknown>[] } {
  return {
    jobs: [...jobs]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map(({ run, token, method, invoke, ...job }) => ({
        ...job,
        token: token ?? HOST,
        method: method ?? 'run',
        invoke: invoke ?? ((_host: unknown, ctx: JobContext) => run?.(ctx)),
      })),
  }
}

/** Metadata with the {@link Host} provider, `providers` and the schedule section of `jobs`. */
export function metadataWith(
  jobs: readonly JobSpec[] = [],
  providers: Readonly<Record<Token, ProviderDefinition>> = {},
  externals: readonly (
    | Token
    | { readonly token: Token; readonly scope?: 'singleton' | 'request' | 'transient'; readonly providedBy?: string }
  )[] = [],
): ZnightMetadata {
  return createMetadata(
    { [HOST]: { scope: 'singleton', class: Host, deps: [], factory: () => new Host() }, ...providers },
    {
      externals: [
        '@znight/schedule#SchedulerRegistry',
        { token: '@znight/schedule#JobContext', scope: 'request' },
        ...externals,
      ],
      ...(jobs.length === 0 ? {} : { extensions: { schedule: scheduleSection(jobs) as never } }),
    },
  )
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

/** An application booted with `SchedulePlugin`. */
export interface Booted extends AsyncDisposable {
  readonly app: Application
  readonly plugin: SchedulePluginInstance
  readonly registry: SchedulerRegistry
  readonly clock: TestClock
  readonly logs: CapturedLogger
}

/** Options of {@link boot}. */
export interface BootOptions {
  readonly metadata?: ZnightMetadata
  /** Plugin options (the test clock is added unless `clock` is given in an object). */
  readonly schedule?: PluginOptions<SchedulePluginOptions>
  readonly plugins?: { readonly before?: readonly Plugin[]; readonly after?: readonly Plugin[] }
  /** Default `true`. */
  readonly start?: boolean
  readonly clock?: TestClock
  readonly overrides?: Readonly<Record<Token, unknown>>
}

/**
 * A test clock for these tests: their runs do no real I/O, and many wait for the test on purpose,
 * so `advance()` gives up on idle runs after 20 ms instead of 1 s.
 */
export function testClock(start: Date | string | number = '2026-01-01T00:00:00Z'): TestClock {
  return createTestClock(start, { settleTimeoutMs: 20 })
}

/** Creates (and starts) an application with `SchedulePlugin` on a test clock. */
export async function boot(options: BootOptions = {}): Promise<Booted> {
  const clock = options.clock ?? testClock()
  const logs = captureLogger()
  const raw = options.schedule ?? {}
  const plugin = SchedulePlugin.configure(
    typeof raw === 'function' ? raw : { clock, ...(raw as SchedulePluginOptions) },
  )
  const app = await Application.create({
    metadata: options.metadata ?? metadataWith(),
    plugins: [...(options.plugins?.before ?? []), plugin, ...(options.plugins?.after ?? [])],
    logger: logs,
    shutdown: { signals: false },
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  })
  if (options.start !== false) await app.start()
  return {
    app,
    plugin,
    registry: app.get(SchedulerRegistry),
    clock,
    logs,
    [Symbol.asyncDispose]: () => app.stop(),
  }
}

/** A promise resolved from the outside. */
export interface Deferred<T = void> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Resolves once `signal` aborts. */
export function aborted(signal: AbortSignal): Promise<unknown> {
  return new Promise(resolve => {
    if (signal.aborted) resolve(signal.reason)
    else signal.addEventListener('abort', () => resolve(signal.reason), { once: true })
  })
}

/** ISO strings of dates. */
export function iso(dates: readonly (Date | undefined)[]): (string | undefined)[] {
  return dates.map(date => date?.toISOString())
}
