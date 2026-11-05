/**
 * The "Serve the schema with GraphQL Yoga" recipe of the GraphQL guide (`docs/guide/graphql.md`),
 * shown there as is from its first import and tested by `yoga.test.ts`: the plugins of the library
 * application, with GraphQL Yoga as the driver of `GraphQLPlugin` (RFC 0009).
 */
import type { Plugin } from '@znight/core'
import type { Plugin as YogaPlugin } from 'graphql-yoga'

import { GraphQLPlugin } from '@znight/graphql'
import { yogaDriver } from '@znight/graphql/yoga'
import { HttpPlugin } from '@znight/http'

/** A Yoga plugin: Envelop and Yoga plugins (persisted operations, response cache...) go to the driver. */
const servedBy: YogaPlugin = {
  onResponse({ response }) {
    response.headers.set('x-graphql-server', 'yoga')
  },
}

export function plugins(): Plugin[] {
  return [
    HttpPlugin.configure(),
    GraphQLPlugin.configure({
      graphiql: process.env['NODE_ENV'] === 'development',
      driver: yogaDriver({ plugins: [servedBy] }),
    }),
  ]
}
