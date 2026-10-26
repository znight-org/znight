/**
 * Analysis of consumers: provider registration, stored data (queue, options, handlers, retry
 * policies, parameters, error handler), static evaluation, inheritance, auto-discovery.
 */
import type { ConsumerData, HandlerData, MemberClassData } from '../../src/compiler/index.ts'

import extension from '../../src/compiler/index.ts'
import {
  analyzeDiscovered,
  analyzeFiles,
  analyzeWithExtension,
  cleanupApps,
  codes,
  MESSAGING_DIR,
  render,
  stored,
  tempApp,
} from './helpers.ts'
import { afterAll, describe, expect, it } from 'bun:test'

afterAll(cleanupApps)

const IMPORTS = `
import { Injectable } from '@znight/core'
import { Consumer, Ctx, Headers, Message, OnError, OnMessage, Retry, type InboundMessage } from '@znight/messaging'
import { z } from 'zod'
`

const ORDERS = `${IMPORTS}
export const OrderPlaced = z.object({ id: z.string(), total: z.number() })

@Injectable()
export class Billing {
  charge(_order: unknown): void {}
}

@Consumer({ queue: 'orders', concurrency: 4, deadLetter: 'orders.failed', groupId: 'billing', scope: 'singleton', missing: undefined })
export class OrderConsumer {
  constructor(private readonly billing: Billing) {}

  @OnMessage('order.placed')
  @Retry({ attempts: 5, backoff: 'exponential', delay: 500, maxDelay: 30_000 })
  async placed(@Message(OrderPlaced) order: z.output<typeof OrderPlaced>, @Headers('x-tenant') tenant?: string) {
    this.billing.charge({ order, tenant })
  }

  @OnMessage('order.*')
  @Retry({ attempts: 1 })
  other(@Ctx() message: InboundMessage, @Headers() headers: Readonly<Record<string, string>>) {
    return [message, headers]
  }

  @OnMessage()
  fallback(@Message() payload: unknown, @Ctx() message: InboundMessage<{ id: string }>) {
    return [payload, message]
  }

  @OnError()
  onError(_error: unknown, _message: InboundMessage): 'ack' | undefined {
    return undefined
  }
}
`

function consumers(result: Parameters<typeof stored>[0]): ConsumerData[] {
  return stored(result).filter((data): data is ConsumerData => data.kind === 'consumer')
}

function only(result: Parameters<typeof stored>[0]): ConsumerData {
  const found = consumers(result)
  expect(found).toHaveLength(1)
  return found[0] as ConsumerData
}

function summary(handler: HandlerData): unknown {
  return {
    method: handler.method,
    type: handler.type,
    retry: handler.retry,
    params: handler.params.map(param =>
      param.kind === 'validated' ? { kind: param.kind, schema: param.schema.name } : param,
    ),
    declaredBy: handler.declaredBy,
  }
}

describe('consumers', () => {
  it('registers @Consumer classes as providers and stores their definition', () => {
    const result = analyzeFiles({ 'src/orders.ts': ORDERS })
    expect(render(result)).toEqual([])
    const provider = result.graph.providers.find(node => node.token === 'src/orders.ts#OrderConsumer')
    expect(provider?.registeredBy).toBe('messaging')
    expect(provider?.scope).toBe('singleton')
    expect(provider?.deps.map(dep => dep.ref)).toEqual(['src/orders.ts#Billing'])

    const consumer = only(result)
    expect({ ...consumer, handlers: undefined, location: undefined }).toEqual({
      kind: 'consumer',
      token: 'src/orders.ts#OrderConsumer',
      identity: 'src/orders.ts#OrderConsumer',
      displayName: 'OrderConsumer',
      queue: 'orders',
      options: { concurrency: 4, deadLetter: 'orders.failed', groupId: 'billing' },
      handlers: undefined,
      errorHandler: 'onError',
      chain: ['src/orders.ts#OrderConsumer'],
      location: undefined,
    })
    expect(consumer.location.line).toBe(13)
    expect(consumer.handlers.map(summary)).toEqual([
      {
        method: 'placed',
        type: 'order.placed',
        retry: { attempts: 5, backoff: 'exponential', delay: 500, maxDelay: 30000 },
        params: [
          { kind: 'validated', schema: 'OrderPlaced' },
          { kind: 'header', name: 'x-tenant' },
        ],
        declaredBy: 'OrderConsumer',
      },
      {
        method: 'other',
        type: 'order.*',
        retry: { attempts: 1, backoff: 'exponential', delay: 1000 },
        params: [{ kind: 'message', narrow: false }, { kind: 'headers' }],
        declaredBy: 'OrderConsumer',
      },
      {
        method: 'fallback',
        type: undefined,
        retry: undefined,
        params: [{ kind: 'payload' }, { kind: 'message', narrow: true }],
        declaredBy: 'OrderConsumer',
      },
    ])
  })

  it('takes the queue from a string argument', () => {
    const result = analyzeFiles({
      'src/a.ts': `${IMPORTS}
@Consumer('emails')
export class EmailConsumer {
  @OnMessage() send(@Message() body: string) { return body }
}`,
    })
    expect(render(result)).toEqual([])
    expect(only(result)).toMatchObject({ queue: 'emails', options: undefined, errorHandler: undefined })
  })

  it.each(['request', 'transient'] as const)('registers the provider with the %s scope', scope => {
    const result = analyzeFiles({
      'src/a.ts': `${IMPORTS}
@Consumer({ queue: 'jobs', scope: '${scope}' })
export class JobConsumer {
  constructor(private readonly message: InboundMessage) {}
  @OnMessage() run() { return this.message.id }
}`,
    })
    // a non-singleton consumer may inject the request-scoped InboundMessage
    expect(codes(result)).toEqual([])
    expect(result.graph.providers.find(node => node.token === 'src/a.ts#JobConsumer')?.scope).toBe(scope)
    expect(only(result).options).toBeUndefined()
  })

  it('reports a singleton consumer injecting the request-scoped InboundMessage (ZNIGHT003)', () => {
    const result = analyzeFiles({
      'src/a.ts': `${IMPORTS}
@Consumer('jobs')
export class JobConsumer {
  constructor(private readonly message: InboundMessage) {}
  @OnMessage() run() { return this.message.id }
}`,
    })
    expect(codes(result)).toEqual(['ZNIGHT003 src/a.ts:8:41'])
  })

  it('evaluates static arguments across files (const references, objects, templates)', () => {
    const result = analyzeFiles({
      'src/names.ts': `
export const PREFIX = 'shop'
export const QUEUES = { orders: \`\${PREFIX}.orders\` } as const
export const TYPES = { placed: 'order.placed' } as const
export const POLICY = { attempts: 2, backoff: 'fixed', delay: 250 } as const
`,
      'src/a.ts': `${IMPORTS}
import { POLICY, QUEUES, TYPES } from './names.ts'

@Consumer({ queue: QUEUES.orders, concurrency: 1 + 1 })
export class OrderConsumer {
  @OnMessage(TYPES.placed)
  @Retry(POLICY)
  placed(@Message() id: string) { return id }
}`,
    })
    expect(render(result)).toEqual([])
    const consumer = only(result)
    expect(consumer.queue).toBe('shop.orders')
    expect(consumer.options).toEqual({ concurrency: 2 })
    expect(consumer.handlers.map(handler => [handler.type, handler.retry])).toEqual([
      ['order.placed', { attempts: 2, backoff: 'fixed', delay: 250 }],
    ])
  })

  it('recognises renamed and namespace imports of the decorators', () => {
    const result = analyzeFiles({
      'src/a.ts': `
import * as msg from '@znight/messaging'
import { OnMessage as Handles } from '@znight/messaging'

@msg.Consumer('audit')
export class AuditConsumer {
  @Handles('audit.*') record(@msg.Message() entry: string) { return entry }
  @msg.OnError() failed() {}
}`,
    })
    expect(render(result)).toEqual([])
    expect(only(result)).toMatchObject({ queue: 'audit', errorHandler: 'failed' })
    expect(only(result).handlers.map(handler => handler.type)).toEqual(['audit.*'])
  })

  it('creates one handler per stacked @OnMessage', () => {
    const result = analyzeFiles({
      'src/a.ts': `${IMPORTS}
@Consumer('orders')
export class OrderConsumer {
  @OnMessage('order.created')
  @OnMessage('order.updated')
  @Retry({ attempts: 2 })
  upsert(@Message() id: string) { return id }
}`,
    })
    expect(render(result)).toEqual([])
    expect(only(result).handlers.map(handler => [handler.method, handler.type, handler.retry?.attempts])).toEqual([
      ['upsert', 'order.created', 2],
      ['upsert', 'order.updated', 2],
    ])
  })

  it('passes undefined for optional parameters without decorator', () => {
    const result = analyzeFiles({
      'src/a.ts': `${IMPORTS}
@Consumer('orders')
export class OrderConsumer {
  @OnMessage() handle(now = Date.now(), @Message() id?: string, extra?: number) { return [now, id, extra] }
}`,
    })
    expect(render(result)).toEqual([])
    expect(only(result).handlers[0]?.params).toEqual([
      { kind: 'undefined' },
      { kind: 'payload' },
      { kind: 'undefined' },
    ])
  })

  it('makes consumers roots of the application (no unused provider)', () => {
    const result = analyzeFiles({ 'src/orders.ts': ORDERS }, { reportUnused: true })
    expect(codes(result)).toEqual([])
    expect(result.graph.reachability?.roots).toContain('src/orders.ts#OrderConsumer')
    expect(result.graph.reachability?.unreachable).toEqual([])
  })

  it('stores nothing for applications without consumers', () => {
    const result = analyzeFiles({
      'src/a.ts': `
import { Injectable } from '@znight/core'
import { MessageBroker } from '@znight/messaging'
@Injectable()
export class Publisher { constructor(readonly broker: MessageBroker) {} }`,
    })
    expect(codes(result)).toEqual([])
    expect(stored(result)).toEqual([])
    expect(result.graph.externals.map(external => external.token)).toEqual(['@znight/messaging#MessageBroker'])
  })
})

describe('inheritance', () => {
  const BASE = `${IMPORTS}
export abstract class BaseConsumer {
  @OnMessage('ping')
  ping(@Message() id: string) { return id }

  @OnMessage('audit.*')
  @Retry({ attempts: 2 })
  audit(@Ctx() message: InboundMessage) { return message }

  @OnError()
  onError(_error: unknown) {}
}
`

  it('inherits the handlers and the @OnError method of base classes (bases first)', () => {
    const result = analyzeFiles({
      'src/base.ts': BASE,
      'src/orders.ts': `${IMPORTS}
import { BaseConsumer } from './base.ts'

@Consumer('orders')
export class OrderConsumer extends BaseConsumer {
  @OnMessage('order.placed')
  placed(@Message() id: string) { return id }

  // override without decorators: the inherited handler calls it
  override ping(id: string) { return id.toUpperCase() }

  // override with decorators: replaces the inherited declaration, at its position
  @OnMessage('audit.**')
  override audit(@Ctx() message: InboundMessage) { return message }
}`,
    })
    expect(render(result)).toEqual([])
    const consumer = only(result)
    expect(consumer.chain).toEqual(['src/orders.ts#OrderConsumer', 'src/base.ts#BaseConsumer'])
    expect(consumer.errorHandler).toBe('onError')
    expect(consumer.handlers.map(handler => [handler.method, handler.type, handler.declaredBy, handler.retry])).toEqual(
      [
        ['ping', 'ping', 'BaseConsumer', undefined],
        ['audit', 'audit.**', 'OrderConsumer', undefined],
        ['placed', 'order.placed', 'OrderConsumer', undefined],
      ],
    )
    // the abstract base class is not a consumer and is not reported
    const base = stored(result).find((data): data is MemberClassData => data.kind === 'members')
    expect(base).toMatchObject({ identity: 'src/base.ts#BaseConsumer', abstract: true })
    expect(result.graph.providers.map(node => node.token)).toEqual(['src/orders.ts#OrderConsumer'])
  })

  it('reports problems of base class members once, at their declaration', () => {
    const result = analyzeFiles({
      'src/base.ts': `${IMPORTS}
export class BaseConsumer {
  @OnMessage('x')
  @Retry({ attempts: 0 })
  x(@Message() id: string) { return id }
}`,
      'src/a.ts': `${IMPORTS}
import { BaseConsumer } from './base.ts'
@Consumer('a') export class A extends BaseConsumer {}
@Consumer('b') export class B extends BaseConsumer {}`,
    })
    expect(codes(result)).toEqual(['ZNIGHT011 src/base.ts:8:12'])
  })
})

describe('auto-discovery', () => {
  it('loads the extension from the @znight/messaging manifest', async () => {
    const app = tempApp({ 'src/orders.ts': ORDERS })
    const discovered = await analyzeDiscovered(app.root)
    const loaded = discovered.extensions.find(entry => entry.extension.name === 'messaging')
    expect(loaded).toMatchObject({
      origin: 'package',
      packageName: '@znight/messaging',
      specifier: '@znight/messaging/compiler',
      path: `${MESSAGING_DIR}/src/compiler/index.ts`,
    })
    expect(loaded?.extension).toBe(extension)
    expect(render(discovered)).toEqual([])
    // same result as with the extension given explicitly
    const explicit = analyzeWithExtension(app.root)
    expect(stored(discovered)).toEqual(stored(explicit))
    expect(discovered.graph.providers.map(node => [node.token, node.registeredBy])).toEqual(
      explicit.graph.providers.map(node => [node.token, node.registeredBy]),
    )
  })

  it('is not loaded when the application does not import @znight/messaging', async () => {
    const app = tempApp({
      'src/a.ts': `import { Injectable } from '@znight/core'\n@Injectable() export class A {}`,
    })
    const result = await analyzeDiscovered(app.root)
    expect(result.extensions.map(entry => entry.extension.name)).not.toContain('messaging')
  })
})
