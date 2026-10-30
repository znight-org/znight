import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

/**
 * The customer behind the current request.
 *
 * `scope: 'request'`: one instance per HTTP request, created on first use inside the request scope
 * opened by the HTTP plugin and dropped once the response is sent. `AuthGuard` fills it when the
 * caller presents a customer token; controllers read it.
 *
 * Singletons cannot inject a request-scoped provider directly (ZNIGHT003: the singleton would keep
 * the first request's customer forever). They inject `Lazy<CurrentCustomer>` and call `get()` while
 * handling a request, which resolves the instance of the current request.
 */
@Injectable({ scope: 'request' })
export class CurrentCustomer {
  #id: string | undefined

  /** Called by the guard once the bearer token is verified. */
  authenticate(customerId: string): void {
    this.#id = customerId
  }

  /** The id of the customer; 401 when the caller is not a customer (public route, API key). */
  get id(): string {
    if (this.#id === undefined) throw new UnauthorizedException('A customer token is required')
    return this.#id
  }
}
