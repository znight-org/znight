import type { DestinationStream } from 'pino'
import type { LoggerLevel } from './levels.ts'
import type { LogTransport } from './transport.ts'

import { loadOptionalPeer } from '../internal/optional.ts'
import { flushSonicBoom, withLevel } from './transport.ts'

/** Options of {@link prettyTransport} (forwarded to `pino-pretty`). */
export interface PrettyOptions {
  /** Colored output. Default: whether the destination is a TTY (pino-pretty's detection). */
  readonly colorize?: boolean
  /** Timestamp format (`dateformat` syntax, `SYS:` prefix for local time). Default: `'SYS:HH:MM:ss.l'`. */
  readonly translateTime?: boolean | string
  /** Comma-separated keys omitted from the output. Default: `'pid,hostname'`. */
  readonly ignore?: string
  /** Print every property on a single line. Default: `false`. */
  readonly singleLine?: boolean
  /** File descriptor: `1` (stdout, default) or `2` (stderr). */
  readonly fd?: 1 | 2
  /** Minimum level written to this transport. */
  readonly level?: LoggerLevel
  /** Any other `pino-pretty` option (`messageFormat`, `levelFirst`, `customColors`...). */
  readonly options?: Readonly<Record<string, unknown>>
}

type PrettyFactory = (options: Record<string, unknown>) => DestinationStream & { flushSync?: () => void }

/**
 * Human-readable, colored output for development, through the optional peer dependency
 * `pino-pretty` (`bun add -d pino-pretty`). It runs in the main thread (no worker), so it works the
 * same on Node.js and Bun. Do not use it in production: emit JSON and let your platform format it.
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
    ignore: options.ignore ?? 'pid,hostname',
    singleLine: options.singleLine ?? false,
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
          // the prettifier is a transform stream: let it process what was written, then flush its output
          setImmediate(() => {
            flushSonicBoom(stream)
            resolve()
          })
        }),
    },
    options.level,
  )
}
