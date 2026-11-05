/**
 * The built-in transport as a driver (RFC 0009 §4.11): GraphQL over HTTP and SSE, the default when
 * the `driver` option is absent. It keeps its privileged access to the internal executor (statuses,
 * formatted results, SSE sessions, the memoised negotiation): its handlers are the ones of
 * `HttpTransport`, unchanged, and it never goes through the public engine.
 */
import type { SseOptions } from '@znight/http'
import type { GraphQLDriver, GraphQLDriverRoute, GraphQLDriverRoutesContext } from '../driver.ts'
import type { GraphQLExecutor } from '../execution.ts'

import { HttpTransport } from './http.ts'

/** What the built-in driver is built from (resolved plugin options). */
export interface BuiltinDriverOptions {
  /** The executor of the plugin, read on the first request (routes may be collected before the bootstrap). */
  readonly executor: () => GraphQLExecutor
  /** Queries over `GET`. */
  readonly get: boolean
  readonly graphiql: boolean
  /** `HttpResponse.sse()` options of GraphQL over SSE; `false`: no event streams. */
  readonly sse: SseOptions | false
}

/** The name of the built-in transport (`GraphQLOperationEvent.driver`), reserved. */
export const BUILTIN_DRIVER = 'builtin'

/** The built-in GraphQL-over-HTTP and SSE endpoint. */
export class BuiltinDriver implements GraphQLDriver {
  readonly name: string = BUILTIN_DRIVER
  readonly #options: BuiltinDriverOptions

  constructor(options: BuiltinDriverOptions) {
    this.#options = options
  }

  /** `POST` on the path, and `GET` when queries over `GET` or GraphiQL are on (the router answers 405 otherwise). */
  routes(context: GraphQLDriverRoutesContext): readonly GraphQLDriverRoute[] {
    const options = this.#options
    const transport = new HttpTransport({
      executor: options.executor,
      endpoint: context.endpoint,
      get: options.get,
      graphiql: options.graphiql,
      sse: options.sse,
    })
    const routes: GraphQLDriverRoute[] = [
      { method: 'POST', path: context.path, name: 'handle', handler: transport.post },
    ]
    if (options.get || options.graphiql) {
      routes.unshift({ method: 'GET', path: context.path, name: 'handle', handler: transport.get })
    }
    return routes
  }

  /** Nothing to start: the handlers read the executor on the first request. */
  start(): void {}
}
