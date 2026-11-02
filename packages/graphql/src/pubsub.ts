/**
 * The `PubSub` contract (RFC 0005 §5.6, §8.7): topics and payloads of subscriptions. `PubSub` is
 * an injectable external of `GraphQLPlugin` (`@znight/graphql#PubSub`, singleton), in memory by
 * default; multi-instance deployments supply their own implementation through the `pubsub` option.
 */

/** Options of {@link PubSub.subscribe}. */
export interface SubscribeOptions {
  /** Ends the subscription when it aborts (client gone, shutdown, `maxDuration`): pass `ctx.signal`. */
  readonly signal?: AbortSignal
}

/**
 * Publishes events to the subscribers of a topic. `Events` maps each topic to its payload type.
 *
 * ```ts
 * interface CatalogEvents {
 *   bookAdded: Book
 * }
 *
 * constructor(private readonly events: PubSub<CatalogEvents>) {}
 *
 * await this.events.publish('bookAdded', book)
 * for await (const book of this.events.subscribe('bookAdded', { signal: ctx.signal })) yield book
 * ```
 */
export abstract class PubSub<Events extends object = Record<string, unknown>> {
  /** Delivers `payload` to the current subscribers of `topic`. */
  abstract publish<K extends keyof Events & string>(topic: K, payload: Events[K]): Promise<void>

  /** The events of `topic` published from now on, until `options.signal` aborts or the iterator returns. */
  abstract subscribe<K extends keyof Events & string>(
    topic: K,
    options?: SubscribeOptions,
  ): AsyncIterableIterator<Events[K]>
}
