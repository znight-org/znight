/**
 * Every diagnostic of the extension (ZNIGHT005, ZNIGHT011, ZNIGHT017), plus the decorator target
 * checks done by the compiler from the extension's decorator specifications.
 */
import type { ZnightOptions } from '@znight/compiler'
import type { AppAnalysis } from './helpers.ts'

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { analyzeDiscovered, analyzeFiles, analyzeWithExtension, cleanupApps, render, tempApp } from './helpers.ts'
import { afterAll, describe, expect, it } from 'bun:test'

afterAll(cleanupApps)

/** Line 1 and 2 of every test file: sources start at line 3. */
const HEADER = `import { Consumer, Ctx, Headers, Message, OnError, OnMessage, Retry, type InboundMessage } from '@znight/messaging'
import { z } from 'zod'
`

/** Analyses `src/a.ts` (= HEADER + source). */
function analyzeSource(source: string, options: ZnightOptions = {}, files: Record<string, string> = {}): AppAnalysis {
  return analyzeFiles({ 'src/a.ts': HEADER + source, ...files }, options)
}

/** `severity code line:column message` of every diagnostic of src/a.ts. */
function problems(source: string, options: ZnightOptions = {}, files: Record<string, string> = {}): string[] {
  return analyzeSource(source, options, files).diagnostics.map(diagnostic => {
    const location = diagnostic.location
    const file = location === undefined ? '-' : location.file.slice(location.file.lastIndexOf('/src/') + 1)
    const at =
      location === undefined ? '' : `${file === 'src/a.ts' ? '' : `${file}:`}${location.line}:${location.column}`
    return `${diagnostic.severity} ${diagnostic.code} ${at} ${diagnostic.message}`
  })
}

describe('ZNIGHT005: invalid decorator usage', () => {
  it('reports decorators applied to the wrong target (decorator specifications)', () => {
    expect(
      problems(`
export class Service {
  constructor(@Message() readonly payload: string) {}
  @Consumer('x') method() {}
  @OnMessage() field = 1
}
@OnMessage()
export class Wrong {}
`),
    ).toEqual([
      'error ZNIGHT005 5:15 @Message cannot be applied to a constructor parameter (allowed on a method parameter)',
      'error ZNIGHT005 6:3 @Consumer cannot be applied to a method (allowed on a class)',
      'error ZNIGHT005 7:3 @OnMessage cannot be applied to a property (allowed on a method)',
      'error ZNIGHT005 9:1 @OnMessage cannot be applied to a class (allowed on a method)',
    ])
  })

  it('reports consumer classes that cannot be providers (core checks)', () => {
    expect(
      problems(`import { Injectable } from '@znight/core'
@Injectable() @Consumer('a') export class A { @OnMessage() a() {} }
@Consumer('b') export abstract class B { @OnMessage() b() {} }
@Consumer('c') class C { @OnMessage() c() {} }
@Consumer('d') export class D<T> { @OnMessage() d(): T | undefined { return undefined } }
void C
`),
    ).toEqual([
      'error ZNIGHT005 4:15 A is registered by several provider decorators (@Injectable and @Consumer)',
      'error ZNIGHT005 5:1 @Consumer cannot register the abstract class B',
      "error ZNIGHT005 6:1 C must be importable by the generated module to be a provider: 'C' is not exported by src/a.ts",
      'error ZNIGHT005 7:1 @Consumer cannot register the generic class D<T>: its type parameters are unbound',
    ])
  })

  it('reports @Consumer without queue or with an invalid argument', () => {
    expect(
      problems(`
@Consumer() export class A { @OnMessage() a() {} }
@Consumer(42 as never) export class B { @OnMessage() b() {} }
@Consumer(process.env.QUEUE as string) export class C { @OnMessage() c() {} }
`),
    ).toEqual([
      'error ZNIGHT005 4:1 @Consumer A: the queue to consume is required',
      'error ZNIGHT005 5:11 @Consumer B: expected a queue name or an options object ({ queue, scope?, concurrency?, deadLetter? }), got 42',
      expect.stringMatching(/^error ZNIGHT005 6:11 Invalid argument 1 of @Consumer: it must be statically evaluable/),
    ])
  })

  it('reports decorators used without call once', () => {
    expect(
      problems(`
@Consumer
export class A {
  @OnMessage('a') @Retry a() {}
}`),
    ).toEqual([
      'error ZNIGHT005 4:1 @Consumer must be called: @Consumer()',
      'error ZNIGHT005 6:19 @Retry must be called: @Retry()',
    ])
  })

  it('reports decorators applied several times', () => {
    expect(
      problems(`
@Consumer('a')
@Consumer('b')
export class A {
  @OnMessage() @Retry({ attempts: 2 }) @Retry({ attempts: 3 }) a() {}
  @OnError() @OnError() failed() {}
}`),
    ).toEqual([
      'error ZNIGHT005 5:1 @Consumer is applied several times on A',
      'error ZNIGHT005 7:40 @Retry is applied several times on A.a()',
      'error ZNIGHT005 8:14 @OnError is applied several times on A.failed()',
    ])
  })

  it('reports handlers the generated code cannot call', () => {
    expect(
      problems(`const KEY = 'computed'
@Consumer('a')
export class A {
  @OnMessage('static') static s() {}
  @OnMessage('private') private p() {}
  @OnMessage('protected') protected q() {}
  @OnMessage('hash') #h() {}
  @OnMessage('getter') get g() { return 1 }
  @OnMessage('computed') [KEY]() {}
  @OnMessage('generator') *gen() {}
  @OnError() private failed() {}
}`),
    ).toEqual([
      'error ZNIGHT005 6:3 @OnMessage cannot be applied to the static method A.s()',
      'error ZNIGHT005 7:3 A.p() must be public: @OnMessage methods are called by the generated code',
      'error ZNIGHT005 8:3 A.q() must be public: @OnMessage methods are called by the generated code',
      'error ZNIGHT005 9:3 @OnMessage cannot be applied to the #private method A.#h()',
      'error ZNIGHT005 10:3 @OnMessage cannot be applied to the accessor A.g()',
      'error ZNIGHT005 11:3 @OnMessage cannot be applied to A.[KEY](): computed method names are not supported',
      'error ZNIGHT005 12:3 @OnMessage cannot be applied to the generator method A.gen()',
      'error ZNIGHT005 13:3 A.failed() must be public: @OnError methods are called by the generated code',
    ])
  })

  it('reports @OnMessage combined with @OnError, and @Retry without @OnMessage', () => {
    expect(
      problems(`
@Consumer('a')
export class A {
  @OnMessage() @OnError() both() {}
  @Retry({ attempts: 2 }) lonely() {}
}`),
    ).toEqual([
      'error ZNIGHT005 6:16 A.both() cannot be both an @OnMessage handler and the @OnError method',
      'error ZNIGHT005 7:3 @Retry has no effect on A.lonely(): it is not an @OnMessage handler',
    ])
  })

  it('reports parameter decorators outside of @OnMessage handlers', () => {
    const result = analyzeSource(`
@Consumer('a')
export class A {
  @OnMessage() a() {}
  helper(@Message() payload: string) { return payload }
  @OnError() failed(error: unknown, @Ctx() message: InboundMessage) { return [error, message] }
}`)
    expect(render(result)).toEqual([
      "error ZNIGHT005 src/a.ts:7:10: @Message has no effect on parameter 'payload' of A.helper(): it is not an @OnMessage handler\n  = hint: Add @OnMessage() to the method, or remove the decorator",
      "error ZNIGHT005 src/a.ts:8:37: @Ctx has no effect on parameter 'message' of A.failed(): it is not an @OnMessage handler\n  = hint: @OnError methods are called with (error, message): remove the decorator",
    ])
  })

  it('reports parameters with several decorators, rest parameters and invalid @OnMessage types', () => {
    expect(
      problems(`
@Consumer('a')
export class A {
  @OnMessage() a(@Message() @Ctx() both: unknown) { return both }
  @OnMessage('b') b(@Message() ...rest: string[]) { return rest }
  @OnMessage(42 as never) c() {}
}`),
    ).toEqual([
      "error ZNIGHT005 6:29 Parameter 'both' of A.a() has several messaging decorators (@Message, @Ctx)",
      "error ZNIGHT005 7:21 @Message cannot be applied to the rest parameter '...rest' of A.b()",
      'error ZNIGHT005 8:14 @OnMessage on A.c() expects a message type (a string), got 42',
    ])
  })

  it('reports @Message arguments that are not schemas', () => {
    expect(
      problems(
        `
import { OrderDto, Aliased } from './dto.ts'
export const OPTIONS = { strict: true }
const Local = z.object({ id: z.string() })
@Consumer('a')
export class A {
  @OnMessage('a') a(@Message(OrderDto as never) order: OrderDto) { return order }
  @OnMessage('b') b(@Message(OPTIONS as never) order: OrderDto) { return order }
  @OnMessage('c') c(@Message(Local) order: OrderDto) { return order }
  @OnMessage('d') d(@Message(z.object({ id: z.string() })) order: OrderDto) { return order }
  @OnMessage('e') e(@Message(Aliased) order: OrderDto) { return order }
}`,
        {},
        {
          'src/dto.ts': `import { z } from 'zod'
export class OrderDto { id = '' }
const Hidden = z.object({ id: z.string() })
export { Hidden as Aliased }`,
        },
      ),
    ).toEqual([
      "error ZNIGHT005 9:30 @Message(OrderDto as never) on A.a(): 'OrderDto' is a class, not a Standard Schema",
      'error ZNIGHT005 10:30 @Message on A.b() expects a Standard Schema (Zod, Valibot, ArkType...), got an object',
      expect.stringMatching(/^error ZNIGHT005 11:30 .*Local.*export/i),
      expect.stringMatching(/^error ZNIGHT005 12:30 Invalid argument 1 of @Message: /),
    ])
  })

  it('reports invalid @Headers names and header parameters that cannot be undefined', () => {
    expect(
      problems(`
@Consumer('a')
export class A {
  @OnMessage('a') a(@Headers('') x?: string) { return x }
  @OnMessage('b') b(@Headers(42 as never) x?: string) { return x }
  @OnMessage('c') c(@Headers('x-tenant') tenant: string) { return tenant }
  @OnMessage('d') d(@Headers('x-tenant') tenant: string | undefined, @Headers('x-b') b = 'x', @Headers('x-c') c?: string) {
    return [tenant, b, c]
  }
  @OnMessage('e') e(@Headers('x-tenant') tenant: unknown, @Headers('x-n') n: string | null) { return [tenant, n] }
}`),
    ).toEqual([
      'error ZNIGHT005 6:30 @Headers on A.a() expects a header name (a non-empty string), got ""',
      'error ZNIGHT005 7:30 @Headers on A.b() expects a header name (a non-empty string), got 42',
      "warning ZNIGHT005 8:50 @Headers(\"x-tenant\") injects 'string | undefined' (the header may be missing) but parameter 'tenant' of A.c() is typed 'string'",
      "warning ZNIGHT005 12:78 @Headers(\"x-n\") injects 'string | undefined' (the header may be missing) but parameter 'n' of A.e() is typed 'null | string'",
    ])
  })

  it('reports messaging methods on classes that are neither consumers nor base classes of one', () => {
    expect(
      problems(`
export class NotAConsumer {
  @OnMessage('a') @Retry({ attempts: 2 }) a(@Message() id: string) { return id }
  @OnError() failed() {}
}
export abstract class SharedHandlers {
  @OnMessage('b') b() {}
}
export class UsedBase {
  @OnMessage('c') c() {}
}
@Consumer('c') export class C extends UsedBase {}
`),
    ).toEqual([
      'error ZNIGHT005 5:3 @OnMessage has no effect: NotAConsumer is not a @Consumer',
      'error ZNIGHT005 5:19 @Retry has no effect: NotAConsumer is not a @Consumer',
      'error ZNIGHT005 6:3 @OnError has no effect: NotAConsumer is not a @Consumer',
    ])
  })
})

describe('ZNIGHT011: invalid consumer', () => {
  it('reports a consumer without handler', () => {
    const result = analyzeSource(`
@Consumer('orders')
export class OrderConsumer {
  handle() {}
  @OnError() failed() {}
}`)
    expect(render(result)).toEqual([
      'error ZNIGHT011 src/a.ts:4:1: @Consumer OrderConsumer has no @OnMessage handler\n  = hint: Decorate at least one public method with @OnMessage() (default handler) or @OnMessage("type")',
    ])
  })

  it('does not report a missing handler when the only @OnMessage is invalid', () => {
    expect(problems(`@Consumer('a') export class A { @OnMessage('') a() {} }`)).toEqual([
      'error ZNIGHT011 3:44 The @OnMessage type of A.a() must be a non-empty string',
    ])
  })

  it('reports several default handlers', () => {
    const result = analyzeSource(`
@Consumer('orders')
export class OrderConsumer {
  @OnMessage() a() {}
  @OnMessage() b() {}
  @OnMessage(undefined) c() {}
}`)
    expect(render(result)).toEqual([
      'error ZNIGHT011 src/a.ts:7:3: @Consumer OrderConsumer: OrderConsumer.a() and OrderConsumer.b() are both default @OnMessage() handlers\n  = hint: Give one of them a message type: @OnMessage("order.created")\n  - First default handler (src/a.ts:6:3)',
      'error ZNIGHT011 src/a.ts:8:3: @Consumer OrderConsumer: OrderConsumer.a() and OrderConsumer.c() are both default @OnMessage() handlers\n  = hint: Give one of them a message type: @OnMessage("order.created")\n  - First default handler (src/a.ts:6:3)',
    ])
  })

  it('reports duplicate types and patterns', () => {
    expect(
      problems(`
@Consumer('orders')
export class OrderConsumer {
  @OnMessage('order.created') a() {}
  @OnMessage('order.*') b() {}
  @OnMessage('order.created') c() {}
  @OnMessage('order.*') d() {}
}`),
    ).toEqual([
      'error ZNIGHT011 8:3 @Consumer OrderConsumer: several @OnMessage handlers for type "order.created" (OrderConsumer.a() and OrderConsumer.c())',
      'error ZNIGHT011 9:3 @Consumer OrderConsumer: several @OnMessage handlers for type "order.*" (OrderConsumer.b() and OrderConsumer.d())',
    ])
  })

  it('reports patterns shadowed by an earlier pattern, not partial overlaps nor exact types', () => {
    const result = analyzeSource(`
@Consumer('orders')
export class OrderConsumer {
  @OnMessage('order.created') exact() {}
  @OnMessage('order.*') any() {}
  @OnMessage('order.created.*') created() {}
  @OnMessage('*.updated') updated() {}
  @OnMessage('*') all() {}
  @OnMessage('audit.*') audit() {}
}`)
    expect(render(result)).toEqual([
      'error ZNIGHT011 src/a.ts:8:3: @Consumer OrderConsumer: the pattern "order.created.*" of OrderConsumer.created() never matches: every type it matches is matched first by "order.*" (OrderConsumer.any())\n  = hint: Patterns are tried in declaration order (after exact types): declare the more specific pattern first\n  - Pattern "order.*" (src/a.ts:7:3)',
      'error ZNIGHT011 src/a.ts:11:3: @Consumer OrderConsumer: the pattern "audit.*" of OrderConsumer.audit() never matches: every type it matches is matched first by "*" (OrderConsumer.all())\n  = hint: Patterns are tried in declaration order (after exact types): declare the more specific pattern first\n  - Pattern "*" (src/a.ts:10:3)',
    ])
  })

  it('checks handler types across inherited handlers', () => {
    expect(
      problems(
        `
import { Base } from './base.ts'
@Consumer('orders')
export class OrderConsumer extends Base {
  @OnMessage('order.created') created() {}
  @OnError() mine() {}
}`,
        {},
        {
          'src/base.ts': `${HEADER}
export abstract class Base {
  @OnMessage('order.created') base() {}
  @OnError() inherited() {}
}`,
        },
      ),
    ).toEqual([
      'error ZNIGHT011 7:3 @Consumer OrderConsumer: several @OnMessage handlers for type "order.created" (Base.base() and OrderConsumer.created())',
      'error ZNIGHT011 8:3 @Consumer OrderConsumer has several @OnError methods: Base.inherited(), OrderConsumer.mine()',
    ])
  })

  it('reports invalid retry options at the offending property', () => {
    expect(
      problems(`
@Consumer('orders')
export class OrderConsumer {
  @OnMessage('a') @Retry({} as never) a() {}
  @OnMessage('b') @Retry({ attempts: 0 }) b() {}
  @OnMessage('c') @Retry({ attempts: 1.5, backoff: 'linear' as never }) c() {}
  @OnMessage('d') @Retry({ attempts: 10_001, delay: -1 }) d() {}
  @OnMessage('e') @Retry({ attempts: 3, delay: 1000, maxDelay: 500 }) e() {}
  @OnMessage('f') @Retry({ attempts: 3, delay: Infinity }) f() {}
  @OnMessage('g') @Retry({ attempt: 3 } as never) g() {}
  @OnMessage('h') @Retry() h() {}
  @OnMessage('i') @Retry(3 as never) i() {}
}`),
    ).toEqual([
      'error ZNIGHT011 6:26 @Retry on OrderConsumer.a(): "attempts" is required',
      'error ZNIGHT011 7:28 @Retry on OrderConsumer.b(): "attempts" must be an integer between 1 and 10000, got 0',
      'error ZNIGHT011 8:28 @Retry on OrderConsumer.c(): "attempts" must be an integer between 1 and 10000, got 1.5',
      `error ZNIGHT011 8:43 @Retry on OrderConsumer.c(): "backoff" must be 'fixed' or 'exponential', got "linear"`,
      'error ZNIGHT011 9:28 @Retry on OrderConsumer.d(): "attempts" must be an integer between 1 and 10000, got 10001',
      'error ZNIGHT011 9:46 @Retry on OrderConsumer.d(): "delay" must be a finite number of milliseconds >= 0, got -1',
      'error ZNIGHT011 10:54 @Retry on OrderConsumer.e(): "maxDelay" must be a finite number of milliseconds >= delay (1000), got 500',
      'error ZNIGHT011 11:41 @Retry on OrderConsumer.f(): "delay" must be a finite number of milliseconds >= 0, got Infinity',
      'error ZNIGHT011 12:26 @Retry on OrderConsumer.g(): "attempts" is required',
      'error ZNIGHT011 12:28 @Retry on OrderConsumer.g(): unknown option "attempt"',
      'error ZNIGHT005 13:19 @Retry on OrderConsumer.h() requires options: @Retry({ attempts: 3 })',
      'error ZNIGHT005 14:26 @Retry on OrderConsumer.i() expects an options object ({ attempts, backoff?, delay?, maxDelay? }), got 3',
    ])
  })

  it('suggests the closest retry option and warns about maxDelay with a fixed backoff', () => {
    const result = analyzeSource(`
@Consumer('orders')
export class OrderConsumer {
  @OnMessage('a') @Retry({ attempts: 2, dealy: 5 } as never) a() {}
  @OnMessage('b') @Retry({ attempts: 2, backoff: 'fixed', maxDelay: 5000 }) b() {}
}`)
    expect(render(result)).toEqual([
      'error ZNIGHT011 src/a.ts:6:41: @Retry on OrderConsumer.a(): unknown option "dealy"\n  = hint: Did you mean "delay"? Valid options: attempts, backoff, delay, maxDelay',
      `warning ZNIGHT011 src/a.ts:7:59: @Retry on OrderConsumer.b(): "maxDelay" has no effect with backoff 'fixed' (every retry waits "delay")\n  = hint: Remove maxDelay, or use backoff: 'exponential'`,
    ])
  })

  it('reports invalid consumer options', () => {
    expect(
      problems(`
@Consumer('') export class A { @OnMessage() a() {} }
@Consumer({ concurrency: 2 } as never) export class B { @OnMessage() b() {} }
@Consumer({ queue: 42 } as never) export class C { @OnMessage() c() {} }
@Consumer({ queue: 'd', scope: 'session' as never }) export class D { @OnMessage() d() {} }
@Consumer({ queue: 'e', concurrency: 0 }) export class E { @OnMessage() e() {} }
@Consumer({ queue: 'f', concurrency: 1.5 }) export class F { @OnMessage() f() {} }
@Consumer({ queue: 'g', deadLetter: '' }) export class G { @OnMessage() g() {} }
@Consumer({ queue: 'h', deadLetter: 'h' }) export class H { @OnMessage() h() {} }
@Consumer({ queue: 'i', deadLetter: false, concurrency: 3, scope: 'request' }) export class I { @OnMessage() i() {} }
`),
    ).toEqual([
      'error ZNIGHT011 4:11 @Consumer A: the queue must be a non-empty string',
      'error ZNIGHT011 5:11 @Consumer B: the "queue" option is required',
      'error ZNIGHT011 6:13 @Consumer C: "queue" must be a non-empty string, got 42',
      `error ZNIGHT011 7:25 @Consumer D: "scope" must be 'singleton', 'request' or 'transient', got "session"`,
      'error ZNIGHT011 8:25 @Consumer E: "concurrency" must be a positive integer, got 0',
      'error ZNIGHT011 9:25 @Consumer F: "concurrency" must be a positive integer, got 1.5',
      'error ZNIGHT011 10:25 @Consumer G: "deadLetter" must be a queue name or false, got ""',
      'error ZNIGHT011 11:25 @Consumer H: the dead-letter queue cannot be the consumed queue "h"',
    ])
  })

  it('reports handler parameters without decorator', () => {
    const result = analyzeSource(`
@Consumer('orders')
export class OrderConsumer {
  @OnMessage() handle(@Message() id: string, tenant: string, optional?: string) { return [id, tenant, optional] }
}`)
    expect(render(result)).toEqual([
      "error ZNIGHT011 src/a.ts:6:46: Parameter 'tenant' of OrderConsumer.handle() has no @Message(), @Headers() or @Ctx() decorator\n  = hint: Every handler parameter is extracted from the message: @Message(schema?) for the payload, @Headers(name?) for the headers, @Ctx() for the InboundMessage",
    ])
  })

  it('reports @OnError signatures the runtime cannot honour', () => {
    expect(
      problems(`
@Consumer('a')
export class A {
  @OnMessage() a() {}
  @OnError() failed(error: unknown, message: InboundMessage, extra: string): boolean { return !!(error && message && extra) }
}
@Consumer('b')
export class B {
  @OnMessage() b() {}
  @OnError() async failed(): Promise<'ack' | void> { return 'ack' }
}
@Consumer('c')
export class C {
  @OnMessage() c() {}
  @OnError() failed(_error: unknown, _message?: InboundMessage, ..._rest: unknown[]): 'ack' | undefined | void {}
}
@Consumer('d')
export class D {
  @OnMessage() d() {}
  @OnError() failed(): string { return 'nack' }
}`),
    ).toEqual([
      "error ZNIGHT011 7:3 The @OnError method A.failed() returns 'boolean': return 'ack' to acknowledge the message, or nothing to dead-letter it",
      'error ZNIGHT011 7:14 The @OnError method A.failed() has 3 required parameters: it is called with (error, message)',
      "error ZNIGHT011 22:3 The @OnError method D.failed() returns 'string': return 'ack' to acknowledge the message, or nothing to dead-letter it",
    ])
  })

  it('reports several consumers of the same queue', () => {
    const result = analyzeFiles({
      'src/a.ts': `${HEADER}@Consumer('orders') export class A { @OnMessage() a() {} }`,
      'src/b.ts': `${HEADER}@Consumer({ queue: 'orders', groupId: 'b' }) export class B { @OnMessage() b() {} }`,
      'src/c.ts': `${HEADER}@Consumer('payments') export class C { @OnMessage() c() {} }`,
    })
    expect(render(result)).toEqual([
      'error ZNIGHT011 src/b.ts:3:1: A and B both consume "orders"\n  = hint: A queue is consumed by a single @Consumer class: merge the handlers, or route by type with @OnMessage(type)\n  - A consumes "orders" (src/a.ts:3:1)',
    ])
  })
})

describe('ZNIGHT017: unvalidated payload', () => {
  const SOURCE = `
interface Order { id: string }
@Consumer('orders')
export class OrderConsumer {
  @OnMessage('a') a(@Message() order: Order) { return order }
  @OnMessage('b') b(@Message() payload: any) { return payload }
  @OnMessage('c') c(@Message() payload) { return payload }
  @OnMessage('d') d(@Message() ids: string[]) { return ids }
  @OnMessage('e') e(@Message() id: string, @Message() n?: number, @Message() flag: boolean | null = null) { return [id, n, flag] }
  @OnMessage('f') f(@Message() raw: unknown, @Message() kind: 'a' | 'b', @Message() bytes: Uint8Array) { return [raw, kind, bytes] }
  @OnMessage('g') g(@Message(undefined) order: Order) { return order }
}`

  it('warns about non-primitive payloads injected without schema', () => {
    expect(problems(SOURCE)).toEqual([
      "warning ZNIGHT017 7:21 Unvalidated message payload: parameter 'order' of OrderConsumer.a() is typed 'Order' but @Message() has no schema",
      "warning ZNIGHT017 8:21 Unvalidated message payload: parameter 'payload' of OrderConsumer.b() is typed 'any' but @Message() has no schema",
      "warning ZNIGHT017 9:21 Unvalidated message payload: parameter 'payload' of OrderConsumer.c() has no type annotation but @Message() has no schema",
      "warning ZNIGHT017 10:21 Unvalidated message payload: parameter 'ids' of OrderConsumer.d() is typed 'string[]' but @Message() has no schema",
      "warning ZNIGHT017 13:21 Unvalidated message payload: parameter 'order' of OrderConsumer.g() is typed 'Order' but @Message() has no schema",
    ])
  })

  it('is an error with strictValidation', () => {
    const result = analyzeSource(SOURCE, { strictValidation: true })
    const severities = result.diagnostics.filter(diagnostic => diagnostic.code === 'ZNIGHT017').map(d => d.severity)
    expect(severities).toEqual(['error', 'error', 'error', 'error', 'error'])
    expect(render(result, 'ZNIGHT017')[0]).toBe(
      "error ZNIGHT017 src/a.ts:7:21: Unvalidated message payload: parameter 'order' of OrderConsumer.a() is typed 'Order' but @Message() has no schema\n  = hint: Validate it with a Standard Schema (Zod, Valibot, ArkType...): @Message(OrderPlaced)\n  = hint: Or declare the parameter as 'unknown' and check it in the handler",
    )
  })

  it('accepts payloads validated with a schema', () => {
    expect(
      problems(`
export const Order = z.object({ id: z.string() })
@Consumer('orders')
export class OrderConsumer {
  @OnMessage() a(@Message(Order) order: z.output<typeof Order>) { return order }
}`),
    ).toEqual([])
  })
})

describe('decorators imported from another package', () => {
  /** An application where `@znight/http` (which has `Headers` and `Ctx` too) is installed. */
  function withHttp(source: string): string {
    const app = tempApp({ 'src/a.ts': source })
    const http = fs.realpathSync.native(fileURLToPath(new URL('../../../http', import.meta.url)))
    fs.symlinkSync(http, `${app.root}/node_modules/@znight/http`, 'dir')
    return app.root
  }

  it('names the package of a handler parameter decorator imported from @znight/http', () => {
    const root = withHttp(`import { Consumer, OnMessage } from '@znight/messaging'
import { Headers } from '@znight/http'

@Consumer('orders')
export class MixedConsumer {
  @OnMessage() handle(@Headers('x-a') a: string | undefined) { return a }
}
`)
    expect(render(analyzeWithExtension(root))).toEqual([
      "error ZNIGHT005 src/a.ts:6:23: @Headers on parameter 'a' of MixedConsumer.handle() is imported from '@znight/http': @OnMessage handler parameters use Headers from '@znight/messaging'\n  = hint: Import it from '@znight/messaging': import { Headers } from '@znight/messaging'",
    ])
  })

  it('points a messaging parameter decorator of an HTTP route to @znight/http', async () => {
    const root = withHttp(`import { Ctx } from '@znight/messaging'
import { Controller, Get } from '@znight/http'

@Controller('/users')
export class UserController {
  @Get('/') list(@Ctx() context: unknown) { return context }
}
`)
    const result = await analyzeDiscovered(root)
    // the messaging extension reports the stray decorator, the http extension reports the route it cannot generate
    expect(render(result).filter(line => line.includes("'@znight/messaging'"))).toEqual([
      "error ZNIGHT005 src/a.ts:6:18: @Ctx (from '@znight/messaging') has no effect on parameter 'context' of UserController.list(): it is not an @OnMessage handler\n  = hint: UserController.list() is a @Get handler: use the parameter decorators of '@znight/http'",
      "error ZNIGHT005 src/a.ts:6:18: @Ctx on parameter 'context' of UserController.list is imported from '@znight/messaging': route parameters use Ctx from '@znight/http'\n  = hint: Import it from '@znight/http': import { Ctx } from '@znight/http'",
    ])
  })
})
