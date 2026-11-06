/**
 * Publishes application events to the listeners generated at build time (RFC 0011 §5.3). Inject it
 * anywhere: it is supplied by `EventsPlugin` (a singleton external of the package manifest).
 *
 * ```ts
 * @Injectable()
 * export class CreateUser {
 *   constructor(
 *     private readonly users: UserRepository,
 *     private readonly events: EventPublisher,
 *   ) {}
 *
 *   async execute(input: NewUser): Promise<User> {
 *     const user = await this.users.insert(input)
 *     await this.events.publish(new UserCreated(user))
 *     return user
 *   }
 * }
 * ```
 *
 * An event is an instance of a class (any class, no base class or decorator needed); listeners are
 * matched on its class and the classes it extends. A plain object or a primitive is a `TypeError`.
 */
export abstract class EventPublisher {
  /**
   * Runs the inline listeners of `event`, in order, in the caller's async context and request
   * scope, then schedules its detached listeners. Resolves once every inline listener settled;
   * rejects with the first inline error, unchanged (the remaining inline listeners and every
   * detached listener are skipped). Without listener, resolves at once.
   *
   * Rejects with ZNIGHT021 before `EventsPlugin` is bootstrapped (in a provider constructor) and
   * once it is disposed.
   */
  abstract publish(event: object): Promise<void>

  /**
   * Fire and forget: starts `publish(event)` in the background, in a fresh scope, and returns. Every
   * error, inline listeners included, goes to the plugin's `onError` (default: the logger). Throws
   * only for an event that is not a class instance, or when the plugin is not running (ZNIGHT021).
   */
  abstract emit(event: object): void
}
