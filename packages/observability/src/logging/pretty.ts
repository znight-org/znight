import type { DestinationStream } from 'pino'
import type { LoggerLevel } from './levels.ts'
import type { LogTransport } from './transport.ts'

import { loadOptionalPeer } from '../internal/optional.ts'
import { formatPrettyMessage } from './pretty-format.ts'
import { drainSonicBoom, withLevel } from './transport.ts'

/** Options of {@link prettyTransport} (forwarded to `pino-pretty`). */
export interface PrettyOptions {
  /** Colored output. Default: whether the destination is a TTY (pino-pretty's detection). */
  readonly colorize?: boolean
  /** Timestamp format (`dateformat` syntax, `SYS:` prefix for local time). Default: `'SYS:HH:MM:ss.l'`. */
  readonly translateTime?: boolean | string
  /**
   * Comma-separated keys omitted from the output. Default: `'pid,hostname,traceId,spanId'` (the
   * trace context is in the JSON output; `requestId` already ties the entries of a request together).
   */
  readonly ignore?: string
  /** Print the trailing properties on the line of the message (errors keep their stack below). Default: `true`. */
  readonly singleLine?: boolean
  /** File descriptor: `1` (stdout, default) or `2` (stderr). */
  readonly fd?: 1 | 2
  /** Minimum level written to this transport. */
  readonly level?: LoggerLevel
  /**
   * Any other `pino-pretty` option (`levelFirst`, `customColors`...), applied last. A `messageFormat`
   * replaces the Znight message format (`messageFormat: false` restores pino-pretty's own).
   */
  readonly options?: Readonly<Record<string, unknown>>
}

type PrettyFactory = (options: Record<string, unknown>) => DestinationStream

/**
 * Human-readable, colored output for development, through the optional peer dependency
 * `pino-pretty` (`bun add -d pino-pretty`). It runs in the main thread (no worker), so it works the
 * same on Node.js and Bun. Do not use it in production: emit JSON and let your platform format it.
 *
 * One line per entry: `[UserService]` before the message of a named logger, a short message for the
 * instrumentation entries (`[GET] [/users/42] - [200] 3.3ms`, `[queue orders] message processed 12ms`),
 * the other fields in a compact `{...}`, error stacks on the following lines.
 *
 * @throws ZnightError (ZNIGHT001) when `pino-pretty` is not installed.
 */
export function prettyTransport(options: PrettyOptions = {}): LogTransport {
  const loaded = loadOptionalPeer<PrettyFactory | { default: PrettyFactory }>(
    'pino-pretty',
    'Pretty logging',
    'or disable it: logging: { pretty: false }',
  )
  const build = typeof loaded === 'function' ? loaded : loaded.default
  const stream = build({
    translateTime: options.translateTime ?? 'SYS:HH:MM:ss.l',
    ignore: options.ignore ?? 'pid,hostname,traceId,spanId',
    singleLine: options.singleLine ?? true,
    messageFormat: formatPrettyMessage,
    destination: options.fd ?? 1,
    sync: true,
    ...(options.colorize === undefined ? {} : { colorize: options.colorize }),
    ...options.options,
  })
  return withLevel(
    {
      name: 'pretty',
      stream,
      flush: () =>
        new Promise<void>(resolve => {
          // the prettifier is a transform stream: let it process what was written, then wait for its output
          setImmediate(() => void drainSonicBoom(stream).then(resolve))
        }),
    },
    options.level,
  )
}
