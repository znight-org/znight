/**
 * Fastify lifecycle check executed by `test/fastify-lanes.test.ts` with Node.js
 * (`node --conditions=@znight/source`) and Bun. The Fastify adapter serves a Znight route from its
 * `onRequest` hook, and writes a text reply on the raw response, only when nothing else needs
 * Fastify's lifecycle: this script serves the same routes with instances whose hooks, `onRoute`
 * wrappers or tracing subscribers require it, and prints, as JSON, the raw responses (date and
 * request id masked) and what the hooks saw, by variant.
 */
import type { HttpContext } from '../../src/index.ts'

import diagnostics from 'node:diagnostics_channel'
import net from 'node:net'
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify'

import { fastifyAdapter } from '../../src/adapters/fastify.ts'
import { coerce } from '../../src/index.ts'
import { controller, createApp, metadata, provider, route, t } from '../helpers.ts'

class ItemsController {
  get(id: number) {
    return { id }
  }
  echo(body: unknown) {
    return body instanceof Uint8Array ? { bytes: body.byteLength } : { body }
  }
  cookie(ctx: HttpContext) {
    ctx.setHeader('x-custom', 'yes')
    ctx.setCookie('a', '1')
    ctx.setCookie('b', '2')
    return 'text'
  }
}

const meta = metadata({ [t('ItemsController')]: provider(ItemsController) }, [
  controller(t('ItemsController'), '/items', [
    route('get', '/:id', (c: ItemsController, ctx) => c.get(coerce.number(ctx.params['id'], 'param "id"'))),
    route('echo', '/echo', (c: ItemsController, ctx) => c.echo(ctx.body), {
      method: 'POST',
      params: [{ index: 0, source: 'body' }],
    }),
    route('cookie', '/cookie', (c: ItemsController, ctx) => c.cookie(ctx)),
  ]),
])

const REQUESTS = [
  'GET /items/1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
  'HEAD /items/1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
  'POST /items/echo HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\ncontent-length: 7\r\nConnection: close\r\n\r\n{"a":1}',
  'POST /items/echo HTTP/1.1\r\nHost: x\r\ncontent-type: foo\r\ncontent-length: 7\r\nConnection: close\r\n\r\n{"a":1}',
  'POST /nope HTTP/1.1\r\nHost: x\r\ncontent-type: foo\r\ncontent-length: 7\r\nConnection: close\r\n\r\n{"a":1}',
  'GET /items/cookie HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
]

/** Sends a raw request and returns the raw response (the server closes the connection). */
function exchange(port: number, request: string): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(`${received} [timeout]`)
    }, 4000)
    socket.on('connect', () => socket.write(request))
    socket.on('data', data => {
      received += data.toString('latin1')
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(received)
    })
    socket.on('error', () => undefined)
  })
}

/** A raw response with its `date` and `x-request-id` values masked. */
function masked(response: string): string {
  return response.replace(/^(date|x-request-id): .*$/gim, '$1: *')
}

const ON_REQUEST = 'onRequest'

interface Variant {
  readonly name: string
  readonly instance: (seen: string[]) => FastifyInstance
}

function withHook(hook: 'preParsing' | 'preValidation' | 'preHandler'): Variant {
  return {
    name: hook,
    instance: seen => {
      const instance = Fastify()
      if (hook === 'preParsing') {
        instance.addHook('preParsing', (request, _reply, payload, done) => {
          seen.push(`${hook} ${request.url}`)
          done(null, payload)
        })
      } else {
        instance.addHook(hook, (request, _reply, done) => {
          seen.push(`${hook} ${request.url}`)
          done()
        })
      }
      return instance
    },
  }
}

const VARIANTS: readonly Variant[] = [
  { name: 'plain', instance: () => Fastify() },
  {
    // which replies go through `reply.send()` (a text reply of a hook-free route is written on the raw response)
    name: 'sends',
    instance: seen => {
      const instance = Fastify()
      instance.addHook(ON_REQUEST, (request, reply, done) => {
        const send = reply.send
        reply.send = function (this: typeof reply, payload?: unknown) {
          seen.push(`send ${request.method} ${request.url}`)
          return send.call(this, payload)
        }
        done()
      })
      return instance
    },
  },
  withHook('preParsing'),
  withHook('preValidation'),
  withHook('preHandler'),
  {
    name: 'onSend',
    instance: seen => {
      const instance = Fastify()
      instance.addHook('onSend', (request, reply, payload, done) => {
        seen.push(`onSend ${request.url}`)
        reply.header('x-on-send', '1')
        done(null, payload)
      })
      return instance
    },
  },
  {
    name: 'onResponse',
    instance: seen => {
      const instance = Fastify()
      instance.addHook('onResponse', (request, reply, done) => {
        seen.push(`onResponse ${request.url} ${String(reply.getHeader('content-type'))}`)
        done()
      })
      return instance
    },
  },
  {
    name: 'onRequestHeader',
    instance: () => {
      const instance = Fastify()
      instance.addHook(ON_REQUEST, (_request, reply, done) => {
        reply.header('x-hook', '1')
        done()
      })
      return instance
    },
  },
  {
    name: 'onRequestTrailer',
    instance: () => {
      const instance = Fastify()
      instance.addHook(ON_REQUEST, (request, reply, done) => {
        if (request.method === 'GET' && request.url === '/items/1') {
          reply.trailer('x-trailer', (_reply, _payload, callback) => callback(null, 'v'))
        }
        done()
      })
      return instance
    },
  },
  {
    name: 'onRouteWrapper',
    instance: seen => {
      const instance = Fastify()
      instance.addHook('onRoute', (options: RouteOptions) => {
        const handler = options.handler
        options.handler = function (this: FastifyInstance, request, reply) {
          seen.push(`wrapped ${request.url}`)
          return handler.call(this, request, reply)
        }
      })
      return instance
    },
  },
  {
    name: 'onRouteOnRequest',
    instance: seen => {
      const instance = Fastify()
      instance.addHook('onRoute', (options: RouteOptions) => {
        options.onRequest = (request, _reply, done) => {
          seen.push(`route onRequest ${request.url}`)
          done()
        }
      })
      return instance
    },
  },
]

type Results = Record<string, { readonly responses: readonly string[]; readonly seen: readonly string[] }>
const results: Results = {}

async function serve(name: string, instance: FastifyInstance, seen: string[]): Promise<void> {
  const app = await createApp(meta, { adapter: fastifyAdapter({ instance }) })
  const port = Number(new URL(String(app.http.address)).port)
  const responses: string[] = []
  for (const request of REQUESTS) responses.push(masked(await exchange(port, request)))
  await app.stop()
  results[name] = { responses, seen }
}

for (const variant of VARIANTS) {
  const seen: string[] = []
  await serve(variant.name, variant.instance(seen), seen)
}

// an APM tracing Fastify's route handlers: every request runs the whole lifecycle
{
  const seen: string[] = []
  const channel = diagnostics.tracingChannel('fastify.request.handler')
  const noop = (): void => undefined
  const subscribers = {
    start: (store: unknown) => {
      seen.push(`traced ${(store as { request: { url: string } }).request.url}`)
    },
    end: noop,
    asyncStart: noop,
    asyncEnd: noop,
    error: noop,
  }
  channel.subscribe(subscribers)
  try {
    await serve('tracing', Fastify(), seen)
  } finally {
    channel.unsubscribe(subscribers)
  }
}

process.stdout.write(JSON.stringify(results))
process.exit(0)
