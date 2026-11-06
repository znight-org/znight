/**
 * `@znight/events/testing`: a recorder of the publications and listener failures of a running
 * application (RFC 0011 §5.13), for `TestApp` tests.
 *
 * ```ts
 * const events = recordEvents(app)
 * await app.inject({ method: 'POST', url: '/users', body: input })
 * await events.idle() // detached listeners settled
 * expect(events.of(UserCreated)).toHaveLength(1)
 * expect(events.failures()).toEqual([])
 * ```
 */
import type { Application, EventListenerEvent } from '@znight/core'
import type { EventClass } from '../metadata.ts'
import type { EventsPluginInstance } from '../plugin.ts'

import { EVENTS_PLUGIN_NAME } from '../plugin.ts'

/** One publication seen by the recorder. */
export interface RecordedPublication {
  /** The published object. */
  readonly event: object
  /** Class name of the event. */
  readonly eventName: string
  readonly mode: 'publish' | 'emit'
}

/** A listener that threw or rejected, inline or detached. */
export interface ListenerFailure {
  readonly event: object
  readonly eventName: string
  /** `Class.method`. */
  readonly listener: string
  readonly detached: boolean
  readonly error: unknown
}

/** Options of {@link EventRecorder.idle}. */
export interface IdleOptions {
  /** Milliseconds before `idle()` rejects. Default: 5 000. */
  readonly timeoutMs?: number
}

/** What {@link recordEvents} returns. */
export interface EventRecorder {
  /** Every publication (`publish` and `emit`) since the recorder started or was cleared, in order. */
  readonly publications: readonly RecordedPublication[]
  /** The published instances of `type` (subclasses included), in publication order. */
  of<E extends object>(type: abstract new (...args: never[]) => E): E[]
  /** The listener failures seen so far, in order. */
  failures(): readonly ListenerFailure[]
  /** Resolves once no detached listener nor `emit()` work is in flight; rejects after the timeout. */
  idle(options?: IdleOptions): Promise<void>
  /** Forgets what was recorded. */
  clear(): void
  /** Stops recording. */
  stop(): void
}

/** An application, or a `TestApp` of `@znight/testing` (`{ app }`). */
export type RecordTarget = Application | { readonly app: Application }

/** Default of {@link IdleOptions.timeoutMs}. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5000

/**
 * Records the publications and listener failures of a running application with `EventsPlugin`
 * (bootstrapped: call it after `TestApp.create()` / `Application.create()`).
 */
export function recordEvents(target: RecordTarget): EventRecorder {
  const app = 'app' in target ? target.app : target
  const plugin = app.getPlugin<EventsPluginInstance>(EVENTS_PLUGIN_NAME)
  if (plugin === undefined) {
    throw new TypeError('[znight] recordEvents(): the application has no EventsPlugin (EventsPlugin.configure())')
  }
  let publications: RecordedPublication[] = []
  let failures: ListenerFailure[] = []
  const unobserve = plugin.observe((event, eventName, mode) => {
    publications.push({ event, eventName, mode })
  })
  const unlisten = app.hooks.on('events:listener', (record: EventListenerEvent) => {
    if (record.error === undefined) return
    failures.push({
      event: record.payload,
      eventName: record.event,
      listener: record.listener,
      detached: record.detached,
      error: record.error,
    })
  })
  return {
    get publications(): readonly RecordedPublication[] {
      return publications
    },
    of<E extends object>(type: EventClass & (abstract new (...args: never[]) => E)): E[] {
      return publications.filter(entry => entry.event instanceof type).map(entry => entry.event as E)
    },
    failures: () => failures,
    async idle(options: IdleOptions = {}): Promise<void> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      })
      try {
        const result = await Promise.race([plugin.idle().then(() => 'idle' as const), timeout])
        if (result === 'timeout') {
          throw new Error(`[znight] recordEvents().idle(): event listeners still running after ${timeoutMs} ms`)
        }
      } finally {
        clearTimeout(timer)
      }
    },
    clear(): void {
      publications = []
      failures = []
    },
    stop(): void {
      unobserve()
      unlisten()
    },
  }
}
