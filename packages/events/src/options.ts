/** Options of `EventsPlugin.configure()` and their validation. */
import { describe, invalidEvents } from './errors.ts'

/** What {@link EventsPluginOptions.onError} receives with the error. */
export interface EventErrorInfo {
  /** The published object. */
  readonly event: object
  /** Class name of the event. */
  readonly eventName: string
  /**
   * `Class.method` of the failing listener; `undefined` when the failure is not a listener's (a hook
   * wrapper of an `emit()`).
   */
  readonly listener: string | undefined
  /** The failing listener is detached. */
  readonly detached: boolean
  /** The publication that ran the listener. */
  readonly mode: 'publish' | 'emit'
}

/**
 * Receives the errors no caller can receive: detached listeners, and every listener of an `emit()`.
 * May be async: the report is part of the tracked work (`idle()` and the drain on stop wait for it).
 * What it throws or rejects with is logged.
 */
export type EventErrorHandler = (error: unknown, info: EventErrorInfo) => unknown

/** Options of `EventsPlugin.configure()`. */
export interface EventsPluginOptions {
  /** Default: `logger.error('Event listener failed', { event, listener, err })` on the application logger. */
  readonly onError?: EventErrorHandler
  /**
   * How long `onStop` waits for the detached listeners and `emit()` work in flight, in milliseconds
   * (`Infinity`: no limit). Default: 4 000. Keep it below `shutdown.hookTimeoutMs` of
   * `Application.create()` (5 000 by default): the application cuts each shutdown step at that budget.
   */
  readonly drainTimeoutMs?: number
}

/** Default of {@link EventsPluginOptions.drainTimeoutMs}. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 4_000

/** Largest delay of a timer (`setTimeout` clamps above it). */
const MAX_TIMER_DELAY = 2_147_483_647

const OPTION_KEYS: readonly string[] = ['onError', 'drainTimeoutMs']

/** Validated options. */
export interface ResolvedEventsOptions {
  readonly onError: EventErrorHandler | undefined
  /** Milliseconds, `Infinity` for no limit. */
  readonly drainTimeoutMs: number
}

/** Validates the options (ZNIGHT070). */
export function resolveEventsOptions(options: unknown): ResolvedEventsOptions {
  const where = 'EventsPlugin.configure()'
  if (options === undefined) return { onError: undefined, drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw invalidEvents(`${where}: options must be an object, got ${describe(options)}`)
  }
  const record = options as Readonly<Record<string, unknown>>
  for (const key of Object.keys(record)) {
    if (!OPTION_KEYS.includes(key)) {
      throw invalidEvents(`${where}: unknown option '${key}'`, [`Options: ${OPTION_KEYS.join(', ')}`])
    }
  }
  const onError = record['onError']
  if (onError !== undefined && typeof onError !== 'function') {
    throw invalidEvents(`${where}: 'onError' must be a function, got ${describe(onError)}`)
  }
  const drain = record['drainTimeoutMs'] ?? DEFAULT_DRAIN_TIMEOUT_MS
  if (typeof drain !== 'number' || Number.isNaN(drain) || drain < 0) {
    throw invalidEvents(
      `${where}: 'drainTimeoutMs' must be a number of milliseconds >= 0 (or Infinity), got ${describe(drain)}`,
    )
  }
  return {
    onError: onError as EventErrorHandler | undefined,
    drainTimeoutMs: drain === Number.POSITIVE_INFINITY ? drain : Math.min(drain, MAX_TIMER_DELAY),
  }
}
