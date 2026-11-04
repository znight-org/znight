/**
 * The "Serve the schema with GraphQL Yoga" recipe of the GraphQL guide (`docs/guide/graphql.md`),
 * shown there as is from its first import and tested by `yoga.test.ts`: Yoga handles the protocol
 * (GraphQL over HTTP, its SSE, GraphiQL, envelop plugins) and hands every operation to
 * `GraphQLPlugin`, which executes it in the request scope of the controller route.
 */
import type { GraphQLPlugin, GraphQLRequest } from '@znight/graphql'
import type { ExecutionArgs } from 'graphql'
import type { Plugin, YogaInitialContext, YogaServerInstance } from 'graphql-yoga'

import { Controller, Ctx, Get, type HttpContext, Post } from '@znight/http'
import { createYoga } from 'graphql-yoga'

type Yoga = YogaServerInstance<Record<string, unknown>, Record<string, unknown>>

/** The operation Yoga received, as `GraphQLPlugin` takes it, and the signal of the request. */
function operation(args: ExecutionArgs): [GraphQLRequest, { signal: AbortSignal }] {
  const { params, request } = args.contextValue as YogaInitialContext
  return [{ ...params, query: params.query ?? '' }, { signal: request.signal }]
}

/** Yoga parses and validates; Znight executes: guards, loaders, request scope, errors and hooks. */
function executeWithZnight(graphql: GraphQLPlugin): Plugin {
  return {
    onExecute({ setExecuteFn }) {
      setExecuteFn(async args => (await graphql.execute(...operation(args))) as never)
    },
    onSubscribe({ setSubscribeFn }) {
      setSubscribeFn(args => graphql.subscribe(...operation(args)) as never)
    },
  }
}

@Controller('/graphql')
export class YogaController {
  #yoga: Yoga | undefined

  constructor(private readonly graphql: GraphQLPlugin) {}

  @Get()
  get(@Ctx() ctx: HttpContext): Promise<Response> {
    return this.#handle(ctx)
  }

  @Post()
  post(@Ctx() ctx: HttpContext): Promise<Response> {
    return this.#handle(ctx)
  }

  async #handle(ctx: HttpContext): Promise<Response> {
    const headers = new Headers()
    for (const [name, value] of Object.entries(ctx.headers)) if (value !== undefined) headers.set(name, value)
    const url = new URL(ctx.url, `${ctx.protocol}://${ctx.header('host') ?? 'localhost'}`)
    const request = new Request(url.href, {
      method: ctx.method,
      headers,
      ...(ctx.method === 'GET' ? {} : { body: await ctx.rawBody() }),
      signal: ctx.signal,
    })
    // the schema exists once the application booted: Yoga is created on the first request
    this.#yoga ??= createYoga({
      schema: this.graphql.schema,
      graphqlEndpoint: '/graphql',
      maskedErrors: false, // GraphQLPlugin already masks unexpected errors
      logging: false, // requests and operations are logged by Znight (@znight/observability)
      plugins: [executeWithZnight(this.graphql)],
    })
    return this.#yoga.fetch(request)
  }
}
