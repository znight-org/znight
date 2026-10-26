/**
 * End to end: an application is analysed, its metadata generated, then run with `Application.create`
 * + `MessagingPlugin` + the memory driver; the generated module is type-checked with the strict user
 * settings of §3.3. Until `@znight/compiler` exports `compile()`, the module is printed by the test
 * printer of `helpers.ts` (same nodes, same import routes); the `compile()` test runs as soon as it
 * exists.
 */
import type { CoreLogger, ZnightMetadata } from '@znight/core'
import type { TempApp } from './helpers.ts'

import fs from 'node:fs'
import path from 'node:path'
import * as compiler from '@znight/compiler'
import { Application } from '@znight/core'

import { MemoryDriver } from '../../src/drivers/memory.ts'
import { MessagingPlugin } from '../../src/index.ts'
import { analyzeWithExtension, cleanupApps, MESSAGING_DIR, printMetadataModule, render, tempApp } from './helpers.ts'
import { afterAll, describe, expect, it } from 'bun:test'

afterAll(cleanupApps)

const APP: Readonly<Record<string, string>> = {
  'src/billing.ts': `import { Injectable } from '@znight/core'

export const calls: unknown[] = []

@Injectable()
export class Billing {
  record(entry: unknown): void {
    calls.push(entry)
  }
}
`,
  'src/audit.ts': `import { Message, OnMessage } from '@znight/messaging'

import { calls } from './billing.ts'

export abstract class AuditBase {
  @OnMessage()
  untyped(@Message() payload: unknown): void {
    calls.push({ handler: 'untyped', payload })
  }
}
`,
  'src/orders.ts': `import {
  Consumer,
  Ctx,
  Headers,
  Message,
  NonRetryableError,
  OnError,
  OnMessage,
  Retry,
  type InboundMessage,
} from '@znight/messaging'
import { z } from 'zod'

import { AuditBase } from './audit.ts'
import { Billing } from './billing.ts'

export const OrderPlaced = z.object({ id: z.string(), total: z.number().default(0) })

@Consumer({ queue: 'orders', concurrency: 2 })
export class OrderConsumer extends AuditBase {
  constructor(private readonly billing: Billing) {
    super()
  }

  @OnMessage('order.placed')
  @Retry({ attempts: 2, backoff: 'fixed', delay: 1 })
  async placed(@Message(OrderPlaced) order: z.output<typeof OrderPlaced>, @Headers('x-tenant') tenant?: string) {
    await Promise.resolve()
    if (order.total < 0) throw new NonRetryableError('Negative total')
    this.billing.record({ handler: 'placed', order, tenant })
  }

  @OnMessage('order.*')
  other(@Ctx() message: InboundMessage<{ id: string }>, @Headers() headers: Readonly<Record<string, string>>): void {
    this.billing.record({ handler: 'other', type: message.type, id: message.payload.id, headers: { ...headers } })
  }

  @OnMessage('order.flaky')
  @Retry({ attempts: 3, backoff: 'fixed', delay: 1 })
  flaky(@Ctx() message: InboundMessage): void {
    if (message.attempt < 3) throw new Error(\`attempt \${message.attempt}\`)
    this.billing.record({ handler: 'flaky', attempt: message.attempt })
  }

  @OnError()
  onError(error: unknown, message: InboundMessage): 'ack' | undefined {
    this.billing.record({ handler: 'onError', type: message.type, error: error instanceof Error ? error.name : 'unknown' })
    return message.headers['x-ignore'] === 'yes' ? 'ack' : undefined
  }
}
`,
}

const silent: CoreLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** Starts the application, sends messages through the memory driver and checks every outcome. */
async function runScenario(app: TempApp, metadata: ZnightMetadata): Promise<void> {
  const { calls } = (await import(app.path('src/billing.ts'))) as { calls: unknown[] }
  calls.length = 0
  const driver = new MemoryDriver()
  const application = await Application.create({
    metadata,
    plugins: [MessagingPlugin.configure({ driver, defaults: { requeueDelay: 5 } })],
    logger: silent,
    shutdown: { signals: false },
  })
  await application.start()
  try {
    driver.send('orders', { id: 'm1', type: 'order.placed', payload: { id: '1' }, headers: { 'X-Tenant': 'acme' } })
    driver.send('orders', { id: 'm2', type: 'order.shipped', payload: { id: '2' }, headers: { a: 'b' } })
    driver.send('orders', { id: 'm3', type: 'order.placed', payload: { id: 3 } })
    driver.send('orders', {
      id: 'm4',
      type: 'order.placed',
      payload: { id: '4', total: -1 },
      headers: { 'x-ignore': 'yes' },
    })
    driver.send('orders', { id: 'm5', payload: 'hello' })
    driver.send('orders', { id: 'm6', type: 'order.flaky', payload: {} })
    await driver.idle()

    expect(calls).toEqual(
      expect.arrayContaining([
        { handler: 'placed', order: { id: '1', total: 0 }, tenant: 'acme' }, // schema output, header lookup
        { handler: 'other', type: 'order.shipped', id: '2', headers: { a: 'b' } }, // pattern, @Ctx, @Headers()
        { handler: 'onError', type: 'order.placed', error: 'MessageValidationError' }, // invalid payload
        { handler: 'onError', type: 'order.placed', error: 'NonRetryableError' },
        { handler: 'untyped', payload: 'hello' }, // inherited default handler
        { handler: 'flaky', attempt: 3 }, // exact type before the pattern, @Retry honoured
      ]),
    )
    expect(calls).toHaveLength(6)
    const outcomes = Object.groupBy(driver.settlements('orders'), settlement => settlement.id)
    expect(Object.fromEntries(Object.entries(outcomes).map(([id, list]) => [id, list?.map(s => s.action)]))).toEqual({
      m1: ['ack'],
      m2: ['ack'],
      m3: ['dead-letter'],
      m4: ['ack'], // @OnError returned 'ack'
      m5: ['ack'],
      m6: ['retry', 'retry', 'ack'],
    })
    expect(driver.deadLetters('orders').map(entry => [entry.message.id, entry.reason])).toEqual([['m3', 'validation']])
  } finally {
    await application.stop()
  }
}

describe('generated metadata at runtime', () => {
  it('runs the consumers of an analysed application', async () => {
    const app = tempApp(APP)
    const result = analyzeWithExtension(app.root)
    expect(render(result)).toEqual([])
    const outFile = app.path('src/.znight/container.generated.ts')
    app.write('src/.znight/container.generated.ts', printMetadataModule(result, outFile))
    const { metadata } = (await import(outFile)) as { metadata: ZnightMetadata }
    expect(Object.keys(metadata.providers)).toEqual(['src/billing.ts#Billing', 'src/orders.ts#OrderConsumer'])
    await runScenario(app, metadata)
  })
})

// --------------------------------------------------------------------------------- type checking

const TSC = path.resolve(MESSAGING_DIR, '../../node_modules/.bin/tsc')
const TYPES_NODE = path.resolve(MESSAGING_DIR, '../../node_modules/@types/node')

/** Type-checks the application with the strict user settings of §3.3; returns the errors of its own files. */
function typecheck(app: TempApp): string[] {
  fs.mkdirSync(app.path('node_modules/@types'), { recursive: true })
  fs.symlinkSync(fs.realpathSync(TYPES_NODE), app.path('node_modules/@types/node'), 'dir')
  app.write(
    'tsconfig.check.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        lib: ['ES2024', 'ESNext.Disposable'],
        module: 'preserve',
        moduleResolution: 'bundler',
        customConditions: ['@znight/source'],
        types: ['node'],
        experimentalDecorators: true,
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noPropertyAccessFromIndexSignature: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        noEmit: true,
      },
      // the generated module lives in a dot-directory, which `include` globs skip
      include: ['src', 'src/.znight/*.ts'],
    }),
  )
  const run = Bun.spawnSync({ cmd: [TSC, '-p', 'tsconfig.check.json', '--pretty', 'false'], cwd: app.root })
  return `${run.stdout.toString()}${run.stderr.toString()}`
    .split('\n')
    .filter(line => line.startsWith('src/'))
    .map(line => line.trim())
}

describe('generated module type checking', () => {
  it.skipIf(!fs.existsSync(TSC))(
    'type-checks under strict user settings',
    () => {
      const app = tempApp(APP)
      const result = analyzeWithExtension(app.root)
      expect(render(result)).toEqual([])
      const outFile = app.path('src/.znight/container.generated.ts')
      app.write('src/.znight/container.generated.ts', printMetadataModule(result, outFile))
      expect(typecheck(app)).toEqual([])
    },
    60_000,
  )

  it.skipIf(!fs.existsSync(TSC))(
    'type-checks handler parameters against the extracted values',
    () => {
      const app = tempApp({
        'src/a.ts': `import { Consumer, Ctx, Headers, Message, OnMessage, type InboundMessage } from '@znight/messaging'
import { z } from 'zod'

export const Order = z.object({ id: z.string() })

@Consumer('a')
export class A {
  @OnMessage('schema') schema(@Message(Order) _order: number): void {}
  @OnMessage('header') header(@Headers('x') _value: number | undefined): void {}
  @OnMessage('ctx') ctx(@Ctx() _message: string): void {}
  @OnMessage('narrow') narrow(@Ctx() _message: InboundMessage<{ id: string }>): void {}
}
`,
      })
      const result = analyzeWithExtension(app.root)
      expect(render(result)).toEqual([])
      const outFile = app.path('src/.znight/container.generated.ts')
      app.write('src/.znight/container.generated.ts', printMetadataModule(result, outFile))
      const errors = typecheck(app)
      // the three mismatched parameters are reported in the generated invokers, the narrowed one is fine
      expect(errors).toHaveLength(3)
      for (const error of errors) expect(error).toStartWith('src/.znight/container.generated.ts(')
    },
    60_000,
  )
})

// ----------------------------------------------------------------------------- compiler pipeline

type Compile = (options: compiler.ZnightOptions) => Promise<{
  readonly code: string
  readonly outFile: string
  readonly diagnostics: readonly compiler.Diagnostic[]
}>

const compile = (compiler as Record<string, unknown>).compile as Compile | undefined

describe('@znight/compiler compile()', () => {
  it.skipIf(typeof compile !== 'function')(
    'generates a module whose consumers run (extension discovered through the manifest)',
    async () => {
      const app = tempApp(APP)
      const result = await (compile as Compile)({ root: app.root, conditions: ['@znight/source'] })
      expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
      app.write(path.relative(app.root, result.outFile), result.code)
      const module = (await import(result.outFile)) as { __ZNIGHT_METADATA__: ZnightMetadata }
      expect(module.__ZNIGHT_METADATA__.extensions?.messaging?.consumers.map(consumer => consumer.token)).toEqual([
        'src/orders.ts#OrderConsumer',
      ])
      await runScenario(app, module.__ZNIGHT_METADATA__)
    },
    60_000,
  )
})
