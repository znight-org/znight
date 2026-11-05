/**
 * End to end: custom parameter decorators (RFC 0010) on message handlers. Function and class
 * resolvers (request-scoped: one instance per delivery), data arguments, resolver errors going
 * through retries and dead letters; the generated module type-checks.
 */
import type { CoreLogger, ZnightMetadata } from '@znight/core'
import type { TempApp } from './helpers.ts'

import fs from 'node:fs'
import path from 'node:path'
import * as compiler from '@znight/compiler'
import { Application } from '@znight/core'

import { MemoryDriver } from '../../src/drivers/memory.ts'
import { MessagingPlugin } from '../../src/index.ts'
import { cleanupApps, MESSAGING_DIR, tempApp } from './helpers.ts'
import { afterAll, describe, expect, it } from 'bun:test'

afterAll(cleanupApps)

const APP: Readonly<Record<string, string>> = {
  'src/tenant.ts': `import type { InboundMessage } from '@znight/messaging'
import type { ParamResolver } from '@znight/core'
import { createParamDecorator, Injectable } from '@znight/core'
import { NonRetryableError } from '@znight/messaging'

export const calls: unknown[] = []
let created = 0

/** One instance per delivery. */
@Injectable({ scope: 'request' })
export class TraceResolver implements ParamResolver<InboundMessage, string> {
  readonly #instance = ++created
  resolve(message: InboundMessage): string {
    return \`\${this.#instance}:\${message.id}\`
  }
}

export const Tenant = createParamDecorator<string>({
  messaging: message => {
    const tenant = message.headers['x-tenant']
    if (tenant === undefined) throw new NonRetryableError('No tenant')
    return tenant
  },
})
export const Header = createParamDecorator<string | undefined, string>({
  messaging: async (message, name) => message.headers[name],
})
export const Trace = createParamDecorator<string>({ messaging: TraceResolver })
`,
  'src/orders.ts': `import { Consumer, Message, OnMessage } from '@znight/messaging'
import { calls, Header, Tenant, Trace } from './tenant.ts'

@Consumer({ queue: 'orders' })
export class OrderConsumer {
  @OnMessage('order.placed')
  placed(@Message() order: unknown, @Tenant() tenant: string, @Header('x-source') source: string | undefined, @Trace() trace: string, @Trace() again: string): void {
    calls.push({ order, tenant, source: source ?? null, same: trace === again, trace })
  }
}
`,
}

const silent: CoreLogger = { debug() {}, info() {}, warn() {}, error() {} }

const TSC = path.resolve(MESSAGING_DIR, '../../node_modules/.bin/tsc')
const TYPES_NODE = path.resolve(MESSAGING_DIR, '../../node_modules/@types/node')

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
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['src', 'src/.znight/*.ts'],
    }),
  )
  const run = Bun.spawnSync({ cmd: [TSC, '-p', 'tsconfig.check.json', '--pretty', 'false'], cwd: app.root })
  return `${run.stdout.toString()}${run.stderr.toString()}`
    .split('\n')
    .filter(line => line.startsWith('src/'))
    .map(line => line.trim())
}

describe('custom parameter decorators on message handlers', () => {
  it('resolves them per delivery; resolver errors fail the delivery', async () => {
    const app = tempApp(APP)
    const compiled = await compiler.compile({ root: app.root, conditions: ['@znight/source'] })
    expect(compiled.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    const code = compiled.code
    expect(code).toContain("['paramResolvers']: ['src/tenant.ts#TraceResolver']")
    expect(code).toContain('x: readonly [TraceResolver]')
    expect(code).toContain(
      "await (Tenant.resolvers.messaging as ParamFunctionOf<typeof Tenant, 'messaging'>)(m, undefined)",
    )
    expect(code).toContain('await x[0].resolve(m)')
    app.write(path.relative(app.root, compiled.outFile), code)
    if (fs.existsSync(TSC)) expect(typecheck(app)).toEqual([])

    const metadata = ((await import(compiled.outFile)) as { __ZNIGHT_METADATA__: ZnightMetadata }).__ZNIGHT_METADATA__
    const { calls } = (await import(app.path('src/tenant.ts'))) as { calls: unknown[] }
    const driver = new MemoryDriver()
    const application = await Application.create({
      metadata,
      plugins: [MessagingPlugin.configure({ driver })],
      logger: silent,
      shutdown: { signals: false },
    })
    await application.start()
    try {
      driver.send('orders', {
        id: 'm1',
        type: 'order.placed',
        payload: { id: 1 },
        headers: { 'x-tenant': 'acme', 'x-source': 'web' },
      })
      driver.send('orders', { id: 'm2', type: 'order.placed', payload: { id: 2 }, headers: { 'x-tenant': 'zen' } })
      driver.send('orders', { id: 'm3', type: 'order.placed', payload: { id: 3 } })
      await driver.idle()
      expect(calls).toEqual([
        { order: { id: 1 }, tenant: 'acme', source: 'web', same: true, trace: '1:m1' },
        { order: { id: 2 }, tenant: 'zen', source: null, same: true, trace: '2:m2' },
      ])
      expect(driver.deadLetters('orders').map(entry => entry.message.id)).toEqual(['m3'])
    } finally {
      await application.stop()
    }
  }, 60_000)
})
