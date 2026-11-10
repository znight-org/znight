/**
 * The one-line messages of the pretty (development) output. `pino-pretty` runs in the main thread
 * (see `pretty.ts`), so its `messageFormat` can be a function: {@link formatPrettyMessage}.
 *
 * Entries written by the instrumentation (`http:request`, `messaging:message`, `schedule:run`,
 * `graphql:operation`, `websocket:*`, `events:publish`) are recognised by their message and the type
 * of their fields, and rendered as a short message (`[GET] [/users/42] - [200] 3.3ms`). Entries of a
 * named logger (`getLogger('UserService')`, `logger` field) or of the framework (`component` field)
 * get a `[UserService]` prefix. Only the pretty output changes: the JSON entries keep every field.
 */

/** A parsed log entry, as `pino-pretty` hands it to `messageFormat`. */
type LogRecord = Record<string, unknown>

/** What a recognised entry renders: its message, and the fields it consumed. */
interface Layout {
  readonly message: string
  readonly consumed: readonly string[]
}

const HTTP_MESSAGES: ReadonlySet<string> = new Set(['request completed', 'request failed'])

const MESSAGE_MESSAGES: ReadonlySet<string> = new Set([
  'message processed',
  'message failed, will be retried',
  'message dead-lettered',
  'message failed',
])

const JOB_MESSAGES: ReadonlySet<string> = new Set(['job completed', 'job failed', 'job skipped', 'job not acquired'])

const GRAPHQL_OUTCOMES: Readonly<Record<string, string>> = {
  'graphql operation completed': '',
  'graphql operation completed with errors': 'completed with errors',
  'graphql operation failed': 'failed',
  'graphql operation rejected': 'rejected',
}

/** Outcomes implied by the message of a WebSocket entry (`handled` / `failed`). */
const WEBSOCKET_IMPLIED_OUTCOMES: Readonly<Record<string, string>> = {
  'websocket message handled': 'ok',
  'websocket message failed': 'error',
}

// The characters pino-pretty strips from messages (terminal escapes included).
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters being removed
const UNSAFE_CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/**
 * `messageFormat` of the pretty transport: the message of `log`, prefixed with its logger name, or
 * the one-line rendering of an instrumentation entry. The fields the message shows are removed from
 * `log`, so `pino-pretty` does not repeat them in the trailing object: it formats the message first,
 * then filters (`ignore`) and prints a copy of what is left. `log` is the entry `pino-pretty` parsed
 * from the JSON line: removing fields never touches the JSON output. Never throws.
 */
export function formatPrettyMessage(log: LogRecord, messageKey: string): string | undefined {
  try {
    const text = textOf(log[messageKey])
    const layout = text === undefined ? undefined : layoutOf(log, text)
    const prefix = prefixOf(log)
    if (layout !== undefined) for (const key of layout.consumed) Reflect.deleteProperty(log, key)
    const message = layout?.message ?? text
    if (prefix === undefined) return message === undefined ? undefined : safe(message)
    return safe(message === undefined || message === '' ? prefix : `${prefix} ${message}`)
  } catch {
    // an odd entry: the message as is
    return fallbackMessage(log, messageKey)
  }
}

function fallbackMessage(log: LogRecord, messageKey: string): string | undefined {
  try {
    const text = textOf(log[messageKey])
    return text === undefined ? undefined : safe(text)
  } catch {
    return undefined
  }
}

/**
 * Compact duration: one decimal under 10 ms (`3.3ms`, `0.4ms`), whole milliseconds under a second
 * (`42ms`), seconds with two decimals above (`1.50s`). `undefined` for anything but a finite number.
 */
export function formatDuration(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 9.95) return `${Number(ms.toFixed(1))}ms`
  if (ms < 999.5) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function layoutOf(log: LogRecord, text: string): Layout | undefined {
  if (HTTP_MESSAGES.has(text)) return httpLayout(log)
  if (MESSAGE_MESSAGES.has(text)) return messageLayout(log, text)
  if (JOB_MESSAGES.has(text)) return jobLayout(log, text)
  if (Object.hasOwn(GRAPHQL_OUTCOMES, text)) return graphqlLayout(log, GRAPHQL_OUTCOMES[text] ?? '')
  if (Object.hasOwn(WEBSOCKET_IMPLIED_OUTCOMES, text)) return websocketMessageLayout(log, text)
  if (text === 'websocket connection closed') return websocketCloseLayout(log)
  if (text === 'event published') return eventLayout(log)
  return undefined
}

/** `[GET] [/users/42] - [200] 3.3ms`. The route template is dropped too: the concrete path says more. */
function httpLayout(log: LogRecord): Layout | undefined {
  const { method, path, status } = log
  if (typeof method !== 'string' || typeof path !== 'string' || typeof status !== 'number') return undefined
  return withDuration(log, `[${method}] [${path}] - [${status}]`, ['method', 'path', 'route', 'status'])
}

/** `[queue orders] message processed 12ms`. */
function messageLayout(log: LogRecord, text: string): Layout | undefined {
  const queue = log['queue']
  if (typeof queue !== 'string') return undefined
  return withDuration(log, `[queue ${queue}] ${text}`, ['queue', 'outcome'])
}

/** `[job cleanup] run completed 40ms`. */
function jobLayout(log: LogRecord, text: string): Layout | undefined {
  const job = log['job']
  if (typeof job !== 'string') return undefined
  return withDuration(log, `[job ${job}] run ${text.slice('job '.length)}`, ['job'])
}

/** `[GraphQL query GetUser] 5.1ms`, `[GraphQL mutation] failed 12ms` (anonymous operation). */
function graphqlLayout(log: LogRecord, outcome: string): Layout | undefined {
  const { operationType, operationName } = log
  if (typeof operationType !== 'string') return undefined
  const name = typeof operationName === 'string' && operationName !== '' ? ` ${operationName}` : ''
  const consumed = typeof operationName === 'string' ? ['operationType', 'operationName'] : ['operationType']
  return withDuration(log, `[GraphQL ${operationType}${name}]${outcome === '' ? '' : ` ${outcome}`}`, [
    ...consumed,
    'outcome',
  ])
}

/** `[WebSocket /chat] message.send handled 2ms`, `... failed (timeout) 5.0s`. */
function websocketMessageLayout(log: LogRecord, text: string): Layout | undefined {
  const { path, event, outcome } = log
  if (typeof path !== 'string') return undefined
  const consumed = ['path']
  let message = `[WebSocket ${path}]`
  if (typeof event === 'string') {
    message += ` ${event}`
    consumed.push('event')
  } else {
    message += ' message'
  }
  message += text === 'websocket message failed' ? ' failed' : ' handled'
  if (outcome === WEBSOCKET_IMPLIED_OUTCOMES[text]) consumed.push('outcome')
  else if (typeof outcome === 'string') {
    message += ` (${outcome})`
    consumed.push('outcome')
  }
  return withDuration(log, message, consumed)
}

/** `[WebSocket /chat] connection closed 1.50s` (how long the connection was open). */
function websocketCloseLayout(log: LogRecord): Layout | undefined {
  const path = log['path']
  if (typeof path !== 'string') return undefined
  return withDuration(log, `[WebSocket ${path}] connection closed`, ['path'])
}

/** `[event UserCreated] published 1.0ms`. */
function eventLayout(log: LogRecord): Layout | undefined {
  const event = log['event']
  if (typeof event !== 'string') return undefined
  return withDuration(log, `[event ${event}] published`, ['event'])
}

/** Appends the `durationMs` field, when there is one, and consumes it. */
function withDuration(log: LogRecord, message: string, consumed: readonly string[]): Layout {
  const duration = formatDuration(log['durationMs'])
  if (duration === undefined) return { message, consumed }
  return { message: `${message} ${duration}`, consumed: [...consumed, 'durationMs'] }
}

/** `[UserService]` for a `getLogger()` logger (`logger` field), `[znight]` for the framework (`component`). */
function prefixOf(log: LogRecord): string | undefined {
  for (const key of ['logger', 'component']) {
    const name = log[key]
    if (typeof name === 'string' && name !== '') {
      Reflect.deleteProperty(log, key)
      return `[${name}]`
    }
  }
  return undefined
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function safe(message: string): string {
  return message.replace(UNSAFE_CONTROL_CHARS, '')
}
