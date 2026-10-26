/**
 * Runtime behaviour of the generated tokens: optional injections bound to nothing get `undefined`
 * (never a provider reached through an alias), and builtin/plugin registrations of tokens supplied at
 * runtime never replace an application provider.
 */
import type { ZnightMetadata } from '@znight/core'

import { Application, Container } from '@znight/core'

import { generate } from '../../src/compiler.ts'
import { tempApp } from '../analysis/helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

// biome-ignore lint/suspicious/noExplicitAny: fixture modules are untyped from the test's point of view
type Any = any

const app = tempApp({
  'node_modules/@fake/broker/package.json': JSON.stringify({
    name: '@fake/broker',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
    znight: { apiVersion: 1, provides: [{ export: 'MessageBroker', plugin: 'BrokerPlugin', scope: 'singleton' }] },
  }),
  'node_modules/@fake/broker/index.d.ts':
    'export declare abstract class MessageBroker {\n  abstract publish(message: string): void\n}\n',
  'node_modules/@fake/broker/index.js': 'export class MessageBroker {}\n',
  'src/types.ts': `
import { type CoreLogger, Inject, Injectable, type Lazy, Optional } from '@znight/core'
import { MessageBroker } from '@fake/broker'

export interface Repository<T> { find(): T }
export interface User { readonly user: true }
export interface Order { readonly order: true }
export abstract class Cache { abstract kind(): string }

@Injectable() export class OrderRepo implements Repository<Order> { find(): Order { return { order: true } } }
@Injectable() export class MemoryCache extends Cache { kind(): string { return 'memory' } }

@Injectable()
export class Consumer {
  constructor(
    readonly users?: Repository<User>,
    @Inject('redis') @Optional() readonly cache?: Cache,
    @Inject('redis') readonly lazyCache?: Lazy<Cache>,
  ) {}
}

@Injectable()
export class AppLogger implements CoreLogger {
  readonly lines: string[] = []
  debug(message: string): void { this.lines.push(message) }
  info(message: string): void { this.lines.push(message) }
  warn(message: string): void { this.lines.push(message) }
  error(message: string): void { this.lines.push(message) }
}

@Injectable()
export class OutboxBroker extends MessageBroker {
  publish(): void {}
}

@Injectable()
export class Service {
  constructor(readonly logger: AppLogger, readonly broker: OutboxBroker) {}
}
`,
})

let metadata: ZnightMetadata
let types: Record<string, Any>

beforeAll(async () => {
  const result = await generate({ root: app.root })
  expect(result.diagnostics).toEqual([])
  metadata = (await import(result.outFile)).__ZNIGHT_METADATA__
  types = await import(`${app.root}/src/types.ts`)
})
afterAll(() => app.cleanup())

describe('optional injections bound to nothing', () => {
  it('inject undefined, even when an alias of the same identity exists', async () => {
    const container = Container.create(metadata)
    await container.init()
    const consumer = container.get(types['Consumer']) as Any
    expect(consumer.users).toBeUndefined() // not OrderRepo (a Repository<Order>)
    expect(consumer.cache).toBeUndefined() // not MemoryCache ('redis' was asked for)
    expect(consumer.lazyCache).toBeUndefined()
    expect(container.get(types['Cache'])).toBeInstanceOf(types['MemoryCache'])
    await container.dispose()
  })
})

describe('tokens supplied at runtime', () => {
  it('keep the application provider implementing CoreLogger (the core registers its own logger)', async () => {
    const application = await Application.create({ metadata, shutdown: { signals: false } })
    const logger = application.container.get(types['AppLogger'])
    expect(logger).toBeInstanceOf(types['AppLogger'])
    expect((application.container.get(types['Service']) as Any).logger).toBe(logger)
    await application.stop()
  })

  it('let a plugin register its own value of an external the application also extends', async () => {
    const container = Container.create(metadata)
    const external = { publish: () => {} }
    container.registerValue('@fake/broker#MessageBroker', external)
    await container.init()
    expect(container.get(types['OutboxBroker'])).toBeInstanceOf(types['OutboxBroker'])
    expect((container.get(types['Service']) as Any).broker).toBeInstanceOf(types['OutboxBroker'])
    await container.dispose()
  })
})
