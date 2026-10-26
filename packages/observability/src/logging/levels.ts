import { invalidOption } from '../internal/errors.ts'

/** Level of a log entry, from the most to the least verbose. */
export type LogEntryLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** Threshold of a logger: an entry level, or `silent` to disable every entry. */
export type LoggerLevel = LogEntryLevel | 'silent'

/** Numeric values used by pino (`"level": 30` in JSON output). */
export const LEVEL_VALUES: Readonly<Record<LoggerLevel, number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
})

const LABELS: ReadonlyMap<number, LogEntryLevel> = new Map([
  [10, 'trace'],
  [20, 'debug'],
  [30, 'info'],
  [40, 'warn'],
  [50, 'error'],
  [60, 'fatal'],
])

/** Whether `value` is a {@link LoggerLevel}. */
export function isLoggerLevel(value: unknown): value is LoggerLevel {
  return typeof value === 'string' && Object.hasOwn(LEVEL_VALUES, value)
}

/** Validates a level option (case-insensitive). */
export function parseLevel(value: unknown, option: string): LoggerLevel {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value
  if (isLoggerLevel(normalized)) return normalized
  throw invalidOption(option, `expected one of ${Object.keys(LEVEL_VALUES).join(', ')}, got ${JSON.stringify(value)}`)
}

/** Validates the level of an entry (`silent` is not an entry level). */
export function parseEntryLevel(value: unknown, option: string): LogEntryLevel {
  const level = parseLevel(value, option)
  if (level === 'silent') throw invalidOption(option, '"silent" is not the level of an entry')
  return level
}

/** Label of a numeric pino level or of a level label in any case (`'INFO'`), `undefined` when unknown. */
export function levelLabel(level: unknown): LogEntryLevel | undefined {
  if (typeof level === 'number') return LABELS.get(level)
  if (typeof level === 'string') {
    const lower = level.toLowerCase()
    return isLoggerLevel(lower) && lower !== 'silent' ? lower : undefined
  }
  return undefined
}
