import type { Logger } from '@znight/observability'
import type { BookAdded } from './book.events.js'

import { OnEvent } from '@znight/events'

/**
 * An **inline** listener: it runs during `publish()`, in the request's scope, before the HTTP
 * response is sent; if it threw, the request would fail with its error. The class becomes a
 * singleton provider because it has an `@OnEvent` method.
 */
export class RecentlyAdded {
  readonly #titles: string[] = []

  @OnEvent()
  remember(event: BookAdded): void {
    this.#titles.unshift(event.book.title)
    this.#titles.length = Math.min(this.#titles.length, 10)
  }

  /** The titles of the last ten books added, most recent first. */
  titles(): readonly string[] {
    return this.#titles
  }
}

/**
 * A **detached** listener: it runs after `publish()` resolved, in its own scope, so it never delays
 * the response; its errors are logged by `EventsPlugin` instead of failing the request. Sending an
 * e-mail or calling a webhook belongs here.
 */
export class NewBookAnnouncer {
  constructor(private readonly logger: Logger) {}

  @OnEvent({ detached: true })
  announce(event: BookAdded): void {
    this.logger.info('New book on the shelf', { bookId: event.book.id, title: event.book.title, by: event.addedBy })
  }
}
