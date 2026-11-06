/**
 * GraphQL Yoga 6 standalone, with its defaults (parse and validation caches, masked errors): the
 * schema from the benchmark SDL and resolvers (`createSchema`), a fresh context (its DataLoader) per
 * request. `Bun.serve()` on Bun, node:http on Node.js.
 */
import { createServer } from 'node:http'
import { createSchema, createYoga } from 'graphql-yoga'

import { type Context, createContext, createResolvers, createServices, host, port, typeDefs } from './catalog.js'

const services = createServices()

const yoga = createYoga({
  schema: createSchema<Context>({ typeDefs, resolvers: createResolvers(services) }),
  context: () => createContext(services),
  graphiql: false,
  logging: false,
})

/** The Bun global, when running on Bun (the baselines type-check against Node.js only). */
interface BunServe {
  serve(options: { hostname: string; port: number; fetch: (request: Request) => Response | Promise<Response> }): unknown
}

const bun = (globalThis as { Bun?: BunServe }).Bun

if (bun === undefined) createServer(yoga).listen(port, host)
else bun.serve({ hostname: host, port, fetch: request => yoga.fetch(request) })
