/**
 * Generation of `metadata.extensions.messaging` (README "Compiler contract"): node structure, printed
 * code, imports, determinism.
 */
import type { GenArrow, GenCall, GenImport, GenNode, GenObject } from '@znight/compiler'

import { analyzeFiles, cleanupApps, generate, importName, print, render } from './helpers.ts'
import { afterAll, describe, expect, it } from 'bun:test'

afterAll(cleanupApps)

const HEADER = `import { Consumer, Ctx, Headers, Message, OnError, OnMessage, Retry, type InboundMessage } from '@znight/messaging'
import { z } from 'zod'
`

/** Analyses `files` (no diagnostic expected) and generates the messaging section. */
function generated(files: Record<string, string>) {
  const result = analyzeFiles(files)
  expect(render(result)).toEqual([])
  return generate(result)
}

function entry(node: GenNode | undefined, key: string): GenNode {
  if (node?.kind !== 'gen:object') throw new Error('not an object')
  const found = node.entries.find(([name]) => name === key)
  if (found === undefined) throw new Error(`no entry ${key}`)
  return found[1]
}

function item(node: GenNode, index: number): GenNode {
  if (node.kind !== 'gen:array') throw new Error('not an array')
  return node.items[index] as GenNode
}

/** `{ module | identity | ref }:{ name }:{ type | value }` of every import. */
function importsOf(imports: readonly GenImport[]): string[] {
  return imports.map(node => {
    const target = node.target
    let where = `ref ${target.kind === 'ref' ? target.ref.identity : ''}`
    if (target.kind === 'module') where = target.module
    if (target.kind === 'identity') where = target.identity
    return `${node.typeOnly ? 'type' : 'value'} ${importName(node)} from ${where}`
  })
}

describe('messaging section', () => {
  it('is omitted when the application has no consumer', () => {
    const result = analyzeFiles({
      'src/a.ts': `import { Injectable } from '@znight/core'\nimport { MessageBroker } from '@znight/messaging'\n@Injectable() export class P { constructor(readonly broker: MessageBroker) {} }`,
    })
    const { node, imports } = generate(result)
    expect(node).toBeUndefined()
    expect(imports).toEqual([])
  })

  it('generates the README example', () => {
    const { node, imports, diagnostics } = generated({
      'src/orders/order.consumer.ts': `${HEADER}
export const OrderPlaced = z.object({ id: z.string(), total: z.number() })

@Consumer('orders')
export class OrderConsumer {
  @OnMessage('order.placed')
  @Retry({ attempts: 5, backoff: 'exponential', delay: 500, maxDelay: 30_000 })
  async placed(@Message(OrderPlaced) order: z.output<typeof OrderPlaced>, @Headers('x-tenant') tenant?: string) {
    return [order, tenant]
  }

  @OnError()
  onError(_error: unknown, message: InboundMessage) {
    if (message.type === 'order.legacy') return 'ack' as const
    return undefined
  }
}`,
    })
    expect(diagnostics).toEqual([])
    expect(node === undefined ? '' : print(node)).toBe(
      '{ consumers: [{ token: "src/orders/order.consumer.ts#OrderConsumer", queue: "orders", handlers: [{ method: "placed", type: "order.placed", retry: { attempts: 5, backoff: "exponential", delay: 500, maxDelay: 30000 }, invoke: async (c: OrderConsumer, m: InboundMessage) => c.placed(await validateMessage(OrderPlaced, m.payload), messageHeader(m, "x-tenant")) }], errorHandler: "onError" }] }',
    )
    expect(importsOf(imports)).toEqual([
      'type OrderConsumer from src/orders/order.consumer.ts#OrderConsumer',
      'type InboundMessage from @znight/messaging',
      'value validateMessage from @znight/messaging',
      'value OrderPlaced from ref src/orders/order.consumer.ts#OrderPlaced',
      'value messageHeader from @znight/messaging',
    ])
  })

  it('builds the section with the generation builders only', () => {
    const { node } = generated({
      'src/a.ts': `${HEADER}
@Consumer({ queue: 'jobs', concurrency: 3, groupId: 'workers' })
export class JobConsumer {
  @OnMessage() run(@Message() id: string) { return id }
}`,
    })
    const consumer = item(entry(node, 'consumers'), 0) as GenObject
    expect(consumer.entries.map(([key]) => key)).toEqual(['token', 'queue', 'options', 'handlers'])
    expect(entry(consumer, 'token')).toEqual({ kind: 'gen:literal', value: 'src/a.ts#JobConsumer' })
    expect(entry(consumer, 'options')).toEqual({ kind: 'gen:literal', value: { concurrency: 3, groupId: 'workers' } })
    const handler = item(entry(consumer, 'handlers'), 0) as GenObject
    expect(handler.entries.map(([key]) => key)).toEqual(['method', 'invoke'])
    const invoke = entry(handler, 'invoke') as GenArrow
    expect(invoke.kind).toBe('gen:arrow')
    expect(invoke.async).toBe(false)
    expect(invoke.params.map(param => [param.name, param.type?.kind])).toEqual([
      ['c', 'gen:import'],
      ['m', 'gen:import'],
    ])
    const call = invoke.body as GenCall
    expect(call.kind).toBe('gen:call')
    expect(call.callee).toEqual({
      kind: 'gen:member',
      object: { kind: 'gen:param', name: 'c' },
      property: 'run',
    })
    expect(call.args.map(arg => arg.kind)).toEqual(['gen:code'])
    expect(print(invoke)).toBe('(c: JobConsumer, m: InboundMessage) => c.run(m.payload as never)')
  })

  it('sorts consumers by token and keeps handlers in declaration order', () => {
    const { node } = generated({
      'src/z.ts': `${HEADER}
@Consumer('z') export class Zeta {
  @OnMessage('b') b() {}
  @OnMessage('a') a() {}
  @OnMessage() c() {}
}`,
      'src/a.ts': `${HEADER}@Consumer('a') export class Alpha { @OnMessage() a() {} }`,
      'src/m/b.ts': `${HEADER}@Consumer('m') export class Beta { @OnMessage() b() {} }`,
    })
    const consumers = entry(node, 'consumers')
    if (consumers.kind !== 'gen:array') throw new Error('not an array')
    expect(consumers.items.map(consumer => print(entry(consumer, 'token')))).toEqual([
      '"src/a.ts#Alpha"',
      '"src/m/b.ts#Beta"',
      '"src/z.ts#Zeta"',
    ])
    expect(print(entry(item(consumers, 2), 'handlers'))).toBe(
      '[{ method: "b", type: "b", invoke: (c: Zeta) => c.b() }, { method: "a", type: "a", invoke: (c: Zeta) => c.a() }, { method: "c", invoke: (c: Zeta) => c.c() }]',
    )
  })

  it('extracts every kind of parameter', () => {
    const { node, imports } = generated({
      'src/a.ts': `${HEADER}
export const Event = z.object({ id: z.string() })
@Consumer({ queue: 'events', scope: 'request' })
export class EventConsumer {
  @OnMessage('payload') payload(@Message() id: string, @Message() raw: unknown) { return [id, raw] }
  @OnMessage('headers') headers(@Headers() all: Readonly<Record<string, string>>, @Headers('x-id') id: string | undefined) { return [all, id] }
  @OnMessage('ctx') ctx(@Ctx() message: InboundMessage, @Ctx() typed: InboundMessage<{ id: string }>, @Ctx() any: InboundMessage<any>) {
    return [message, typed, any]
  }
  @OnMessage('mixed') mixed(now = 0, @Message(Event) event: z.output<typeof Event>, later?: number) { return [now, event, later] }
  @OnMessage('none') none(optional?: string) { return optional }
  @OnMessage('quoted') 'order-created'(@Message() id: string) { return id }
}`,
    })
    const consumer = item(entry(node, 'consumers'), 0)
    expect(entry(consumer, 'handlers').kind).toBe('gen:array')
    const invokes = (entry(consumer, 'handlers') as { items: readonly GenNode[] }).items.map(handler =>
      print(entry(handler, 'invoke')),
    )
    expect(invokes).toEqual([
      '(c: EventConsumer, m: InboundMessage) => c.payload(m.payload as never, m.payload as never)',
      '(c: EventConsumer, m: InboundMessage) => c.headers(m.headers, messageHeader(m, "x-id"))',
      '(c: EventConsumer, m: InboundMessage) => c.ctx(m, m as InboundMessage<never>, m)',
      'async (c: EventConsumer, m: InboundMessage) => c.mixed(undefined, await validateMessage(Event, m.payload))',
      '(c: EventConsumer) => c.none()',
      '(c: EventConsumer, m: InboundMessage) => c["order-created"](m.payload as never)',
    ])
    // each helper is imported once, the class type once per consumer
    expect(importsOf(imports)).toEqual([
      'type EventConsumer from src/a.ts#EventConsumer',
      'type InboundMessage from @znight/messaging',
      'value messageHeader from @znight/messaging',
      'value validateMessage from @znight/messaging',
      'value Event from ref src/a.ts#Event',
    ])
  })

  it('imports nothing it does not use', () => {
    const { imports, node } = generated({
      'src/a.ts': `${HEADER}@Consumer('a') export class A { @OnMessage() a() {} }`,
    })
    expect(importsOf(imports)).toEqual(['type A from src/a.ts#A'])
    expect(node === undefined ? '' : print(node)).toBe(
      '{ consumers: [{ token: "src/a.ts#A", queue: "a", handlers: [{ method: "a", invoke: (c: A) => c.a() }] }] }',
    )
  })

  it('emits inherited handlers on the consumer type', () => {
    const { node } = generated({
      'src/base.ts': `${HEADER}
export abstract class Base {
  @OnMessage('ping') @Retry({ attempts: 2, backoff: 'fixed', delay: 10 }) ping(@Message() id: string) { return id }
  @OnError() failed() {}
}`,
      'src/a.ts': `${HEADER}
import { Base } from './base.ts'
@Consumer('a') export class A extends Base {}`,
    })
    expect(node === undefined ? '' : print(node)).toBe(
      '{ consumers: [{ token: "src/a.ts#A", queue: "a", handlers: [{ method: "ping", type: "ping", retry: { attempts: 2, backoff: "fixed", delay: 10 }, invoke: (c: A, m: InboundMessage) => c.ping(m.payload as never) }], errorHandler: "failed" }] }',
    )
  })

  it('is deterministic', () => {
    const files = {
      'src/b.ts': `${HEADER}export const S = z.string()\n@Consumer('b') export class B { @OnMessage('x') x(@Message(S) s: string, @Headers('h') h?: string) { return [s, h] } }`,
      'src/a.ts': `${HEADER}@Consumer({ queue: 'a', deadLetter: false }) export class A { @OnMessage() a(@Ctx() m: InboundMessage) { return m } @OnError() e() {} }`,
    }
    const first = generated(files)
    const second = generated(files)
    expect(first.node === undefined ? '' : print(first.node)).toBe(second.node === undefined ? '' : print(second.node))
    expect(importsOf(first.imports)).toEqual(importsOf(second.imports))
  })
})
