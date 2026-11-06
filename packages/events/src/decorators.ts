/**
 * The marker decorator of `@znight/events`. Like every Znight decorator it does nothing at runtime:
 * the compiler extension (`@znight/events/compiler`) reads it from the source code, reads the event
 * class from the type of the method's parameter, validates both and generates
 * `metadata.extensions.events` (RFC 0011 §5.4).
 */

/** Options of {@link OnEvent}. Static values only (literals, `const` references). */
export interface OnEventOptions {
  /**
   * Position among the listeners of an event, ascending (default `0`); ties are broken by provider
   * token, then method name. Inline listeners run in that order; detached ones start in it.
   */
  readonly order?: number
  /**
   * Run after the publication, once its inline listeners succeeded, in a fresh scope, with errors
   * reported (`EventsPlugin.configure({ onError })`, logs, hooks) instead of thrown. Default: `false`
   * (inline: in the publisher's scope, the first error rejects `publish()`).
   */
  readonly detached?: boolean
}

/** Type-checks the decorated method: one parameter, the event (any return type). */
export type EventListenerMarker = <F extends (event: never) => unknown>(
  target: object,
  propertyKeyOrContext: string | symbol | ClassMethodDecoratorContext,
  descriptor?: TypedPropertyDescriptor<F>,
) => void

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const listenerMarker: EventListenerMarker = marker

/**
 * Marks a provider method as a listener of the event class its parameter is typed with: a class, a
 * union of classes, or a base class (its subclasses are delivered too). A class with `@OnEvent`
 * methods becomes a singleton provider when it is not one already.
 *
 * ```ts
 * export class WelcomeMail {
 *   constructor(private readonly mail: MailService) {}
 *
 *   @OnEvent({ detached: true })
 *   async send(event: UserCreated): Promise<void> {
 *     await this.mail.welcome(event.user)
 *   }
 * }
 * ```
 */
export function OnEvent(_options?: OnEventOptions): EventListenerMarker {
  return listenerMarker
}
