/**
 * Instrumentation event of the `messaging:publish` hook: `MessageBroker.publish()` runs the
 * publication through `hooks.run` when wrappers are registered, then emits the event to listeners
 * (`hooks.on`). Wrappers may add headers (e.g. W3C trace context) before calling `next()`: they are
 * sent with the message.
 *
 * ```ts
 * hooks.wrap('messaging:publish', (event, next) => {
 *   event.headers.traceparent = currentTraceParent()
 *   return next()
 * })
 * ```
 */
export interface MessagePublishEvent {
  readonly queue: string
  readonly type: string | undefined
  readonly messageId: string
  /** Headers sent with the message (mutable until `next()` is called). */
  readonly headers: Record<string, string>
  /** `performance.now()` when the publication started. */
  readonly startTime: number
  /** Publication error, set before `next()` rejects in the wrappers. */
  error?: unknown
}

declare module '@znight/core' {
  interface ZnightHooks {
    /** One message published through `MessageBroker` (wrapped with `hooks.run`). */
    'messaging:publish': MessagePublishEvent
  }
}
