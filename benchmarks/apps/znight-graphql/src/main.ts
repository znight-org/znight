import type { GraphQLDriver } from '@znight/graphql'
import type { HttpAdapter } from '@znight/http'

import { GraphQLPlugin } from '@znight/graphql'
import { HttpPlugin, nodeAdapter } from '@znight/http'

import { createApplication } from './.znight/container.generated.js'

/** The adapter named by `ADAPTER`: the same resolvers are served by each of them. */
async function adapter(name = 'node'): Promise<HttpAdapter> {
  switch (name) {
    case 'node':
      return nodeAdapter()
    case 'fastify':
      return (await import('@znight/http/fastify')).fastifyAdapter()
    default:
      throw new Error(`Unknown adapter '${name}'`)
  }
}

/** The GraphQL server named by `GRAPHQL_DRIVER`: the built-in transport (`undefined`) or GraphQL Yoga. */
async function driver(name = 'builtin'): Promise<GraphQLDriver | undefined> {
  switch (name) {
    case 'builtin':
      return undefined
    case 'yoga':
      return (await import('@znight/graphql/yoga')).yogaDriver()
    default:
      throw new Error(`Unknown GraphQL driver '${name}'`)
  }
}

const graphql = await driver(process.env['GRAPHQL_DRIVER'])

const app = await createApplication({
  plugins: [
    HttpPlugin.configure({
      adapter: await adapter(process.env['ADAPTER']),
      host: '127.0.0.1',
      port: Number(process.env['PORT'] ?? 3000),
    }),
    // The defaults otherwise: POST /graphql, document cache of 1,000 parsed and validated documents,
    // introspection on (NODE_ENV is not `production`), no GraphiQL (NODE_ENV is not `development`)
    GraphQLPlugin.configure(graphql === undefined ? {} : { driver: graphql }),
  ],
})

await app.start()
