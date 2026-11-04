/**
 * A GraphQL driver for the tests (RFC 0009 §11, M1): the server-agnostic handler of `graphql-http`
 * (the reference implementation of the GraphQL-over-HTTP draft) on top of `GraphQLEngine`, mounted
 * as route-mounted driver routes. It shows that the engine's functions fit a third-party server as
 * they are (`parse`, `validate`, `execute`), and lets the `graphql-http` audits run against the
 * engine through `HttpPlugin`'s pipeline on every adapter. No Fetch object: the handler's request
 * is built from `HttpContext`.
 */
import type { HttpContext } from '@znight/http'
import type { Handler } from 'graphql-http'
import type { GraphQLDriver, GraphQLDriverContext, GraphQLEngine } from '../../src/index.ts'

import { HttpResponse } from '@znight/http'
import { createHandler } from 'graphql-http'

/** The server context the driver gives the engine: `GraphQLContext.serverContext` in resolvers. */
export interface GraphQLHttpServerContext {
  readonly driver: 'graphql-http'
  readonly http: HttpContext
}

/** What the test driver records of its lifecycle. */
export interface GraphQLHttpDriver extends GraphQLDriver {
  readonly events: string[]
  /** The engine given to `start()`. */
  readonly engine: GraphQLEngine | undefined
  readonly context: GraphQLDriverContext | undefined
}

const UTF8 = new TextDecoder()

/** A route-mounted driver serving `graphql-http`'s handler on `GET` and `POST`. */
export function graphqlHttpDriver(): GraphQLHttpDriver {
  let handler: Handler<HttpContext, undefined> | undefined
  const events: string[] = []
  const driver = {
    name: 'graphql-http',
    events,
    engine: undefined as GraphQLEngine | undefined,
    context: undefined as GraphQLDriverContext | undefined,
    routes({ path }: { path: string }) {
      events.push('routes')
      const handle = (ctx: HttpContext): Promise<HttpResponse<string | undefined>> => {
        if (handler === undefined) throw new Error('the graphql-http driver is not started')
        return handler({
          method: ctx.method,
          url: ctx.url,
          headers: { get: name => ctx.header(name.toLowerCase()) ?? null },
          body: () => ctx.rawBody().then(bytes => UTF8.decode(bytes)),
          raw: ctx,
          context: undefined,
        }).then(
          ([body, init]) => new HttpResponse(body ?? undefined, { status: init.status, headers: init.headers ?? {} }),
        )
      }
      return [
        { method: 'GET' as const, path, name: 'graphqlHttp', handler: handle },
        { method: 'POST' as const, path, name: 'graphqlHttp', handler: handle },
      ]
    },
    start(engine: GraphQLEngine, context: GraphQLDriverContext) {
      events.push('start')
      driver.engine = engine
      driver.context = context
      handler = createHandler<HttpContext, undefined, Record<string, unknown>>({
        schema: engine.schema,
        parse: engine.parse,
        validate: engine.validate,
        execute: args => engine.execute(args),
        context: req => ({ driver: 'graphql-http', http: req.raw }) satisfies GraphQLHttpServerContext,
      })
    },
    stop() {
      events.push('stop')
      handler = undefined
    },
  }
  return driver
}
