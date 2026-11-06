/** Runtime errors of `@znight/events`. */
import { ErrorCode, ZnightError } from '@znight/core'

/** ZNIGHT021: `publish()` / `emit()` before `EventsPlugin.onBootstrap`, or once the plugin is disposed. */
export function notRunningError(action: 'publish' | 'emit' | 'observe', state: 'created' | 'disposed'): ZnightError {
  const early = state === 'created'
  return new ZnightError(
    ErrorCode.LifecycleFailed,
    early
      ? `${action === 'observe' ? 'EventsPlugin' : 'EventPublisher'}.${action}(): EventsPlugin is not bootstrapped yet`
      : `${action === 'observe' ? 'EventsPlugin' : 'EventPublisher'}.${action}(): EventsPlugin is disposed`,
    {
      hints: early
        ? [
            'Publish from a method, onStart/onReady, a request, a message or a job, not from a provider constructor or factory',
            'Is EventsPlugin.configure() listed in Application.create({ plugins })?',
          ]
        : ['The application is stopped: events can no longer be published'],
    },
  )
}

/** ZNIGHT070: invalid plugin options or malformed `metadata.extensions.events`. */
export function invalidEvents(message: string, hints: readonly string[] = []): ZnightError {
  return new ZnightError(ErrorCode.InvalidEventListener, message, hints.length === 0 ? {} : { hints })
}

/** The `TypeError` of a published value that is not a class instance (RFC 0011 §5.2). */
export function notAnEventError(action: 'publish' | 'emit', value: unknown): TypeError {
  return new TypeError(
    `[znight] EventPublisher.${action}() expects an instance of a class, got ${describe(value)}: listeners are matched on the class of the event`,
  )
}

/** Short description of a value for messages. */
export function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value)
    case 'object':
      return 'a plain object'
    case 'function':
      return `a function (${value.name || 'anonymous'})`
    case 'bigint':
      return `${value}n`
    default:
      return String(value)
  }
}
