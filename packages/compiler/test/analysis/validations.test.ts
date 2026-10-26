/**
 * Validation codes of the core analysis (§4.8): one fixture application per family in
 * `test/fixtures/analysis/<name>`. Near-miss and decorator messages are snapshotted.
 */
import fs from 'node:fs'

import { analyzeFixture, analyzeRoot, codes, provider, renderDiagnostics, tempApp, withCode } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

describe('ZNIGHT001: missing providers and near-miss analysis', () => {
  it('explains every near miss', async () => {
    const result = await analyzeFixture('missing', { exclude: ['**/*.test.*', 'src/excluded/**'] })
    expect(codes(result)).toEqual([
      'ZNIGHT001 src/consumer.ts:13:21',
      'ZNIGHT001 src/consumer.ts:14:24',
      'ZNIGHT001 src/consumer.ts:15:21',
      'ZNIGHT001 src/consumer.ts:16:23',
      'ZNIGHT001 src/consumer.ts:17:25',
      'ZNIGHT001 src/consumer.ts:18:40',
      'ZNIGHT001 src/consumer.ts:20:22',
      'ZNIGHT001 src/consumer.ts:21:36',
      'ZNIGHT001 src/consumer.ts:22:20',
    ])
    expect(renderDiagnostics(result.root, result.diagnostics)).toMatchSnapshot()
  })

  it('never shows raw identities alone in messages', async () => {
    const result = await analyzeFixture('missing', { exclude: ['**/*.test.*', 'src/excluded/**'] })
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message).not.toMatch(/src\/[\w/.-]+#/)
    }
  })
})

describe('ZNIGHT002: circular dependencies', () => {
  it('reports one cycle per strongly connected component, over parameters, multi, interceptors and factories', async () => {
    const result = await analyzeFixture('cycles')
    expect(codes(result)).toEqual([
      'ZNIGHT002 src/factory.ts:7:37',
      'ZNIGHT002 src/intercepted.ts:4:33',
      'ZNIGHT002 src/ring.ts:5:27',
      'ZNIGHT002 src/self.ts:5:31',
    ])
    expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'Circular dependency: ConnectionFactory -> ConnectionFactory.connection -> ConnectionFactory',
      'Circular dependency: AuditInterceptor -> AuditedService -> AuditInterceptor',
      'Circular dependency: RingA -> RingB -> RingC -> RingA',
      'Circular dependency: SelfDependent -> SelfDependent',
    ])
    const ring = withCode(result, 'ZNIGHT002')[2]
    expect(ring?.hints).toEqual([
      'Break the cycle with Lazy<T>: inject Lazy<RingB> in RingA and call .get() when the dependency is needed',
    ])
    expect(ring?.related?.map(related => related.message)).toEqual([
      "RingA -> RingB (parameter 'b' of RingA)",
      "RingB -> RingC (parameter 'c' of RingB)",
      "RingC -> RingA (parameter 'a' of RingC)",
    ])
  })

  it('accepts cycles broken by Lazy<T> and still orders every provider', async () => {
    const result = await analyzeFixture('cycles')
    expect(result.diagnostics.some(diagnostic => diagnostic.message.includes('Chicken'))).toBe(false)
    expect([...result.graph.resolutionOrder].sort()).toEqual(result.graph.providers.map(node => node.token))
    const order = result.graph.resolutionOrder
    expect(order.indexOf('src/lazy.ts#Chicken')).toBeLessThan(order.indexOf('src/lazy.ts#Egg'))
  })
})

describe('ZNIGHT003: scope mismatches', () => {
  it('reports singletons depending on request scope directly, through transients, multi, interceptors and externals', async () => {
    const result = await analyzeFixture('scopes')
    expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'Scope mismatch: singleton DirectSingleton depends on request-scoped CurrentUser (DirectSingleton -> CurrentUser)',
      'Scope mismatch: singleton ThroughTransient depends on request-scoped CurrentUser (ThroughTransient -> Formatter -> CurrentUser)',
      'Scope mismatch: singleton UsesExternal depends on request-scoped WebContext (UsesExternal -> WebContext)',
      'Scope mismatch: singleton UsesMulti depends on request-scoped RequestHandler (UsesMulti -> RequestHandler)',
      'Scope mismatch: singleton Intercepted depends on request-scoped RequestInterceptor (Intercepted -> RequestInterceptor)',
    ])
    expect(new Set(result.diagnostics.map(diagnostic => diagnostic.code))).toEqual(new Set(['ZNIGHT003']))
    expect(result.diagnostics[1]?.hints).toEqual([
      'Inject Lazy<CurrentUser> and call .get() while a request is being handled',
      "Or make ThroughTransient request-scoped: @Injectable({ scope: 'request' })",
    ])
    expect(result.graph.externals.map(external => [external.token, external.scope])).toEqual([
      ['@znight/fake-web#WebContext', 'request'],
    ])
  })
})

describe('ZNIGHT004 / ZNIGHT008: duplicates and ambiguities', () => {
  it('distinguishes duplicates of the exact same type from ambiguous candidates', async () => {
    const result = await analyzeFixture('duplicates')
    expect(codes(result)).toEqual([
      'ZNIGHT004 src/pool.ts:51:20',
      'ZNIGHT008 src/pool.ts:52:24',
      'ZNIGHT008 src/pool.ts:53:21',
    ])
    expect(renderDiagnostics(result.root, result.diagnostics)).toMatchSnapshot()
  })

  it('never fails a multi injection', async () => {
    const result = await analyzeFixture('duplicates')
    const consumer = result.graph.providers.find(node => node.token === 'src/pool.ts#Consumer')
    expect(consumer?.deps[3]?.ref).toEqual({ multi: ['src/pool.ts#EmailNotifier', 'src/pool.ts#SmsNotifier'] })
  })
})

describe('ZNIGHT005: invalid decorator usage', () => {
  it('reports every listed case', async () => {
    const result = await analyzeFixture('decorators')
    expect(new Set(result.diagnostics.map(diagnostic => diagnostic.code))).toEqual(new Set(['ZNIGHT005']))
    expect(renderDiagnostics(result.root, result.diagnostics)).toMatchSnapshot()
  })

  it('reports composite decorators as warnings', async () => {
    const result = await analyzeFixture('decorators')
    expect(codes(result, 'warning')).toEqual(['ZNIGHT005 src/composite.ts:9:1', 'ZNIGHT005 src/composite.ts:12:1'])
  })
})

describe('ZNIGHT009: lifecycle hooks', () => {
  it('reports static hooks and required parameters (errors), useless hooks (warnings)', async () => {
    const result = await analyzeFixture('lifecycle')
    expect(codes(result, 'error')).toEqual([
      'ZNIGHT009 src/hooks.ts:5:10',
      'ZNIGHT009 src/hooks.ts:10:3',
      'ZNIGHT009 src/hooks.ts:34:3',
    ])
    expect(codes(result, 'warning')).toEqual(['ZNIGHT009 src/hooks.ts:24:3', 'ZNIGHT009 src/hooks.ts:30:4'])
    expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'Lifecycle hook StaticHook.onStart must not be static: hooks are called on the instance',
      'Lifecycle hook RequiredParameter.onStop must not have required parameters: it is called without arguments',
      'RequestHook.onReady is never called: RequestHook is request-scoped and only singletons receive lifecycle hooks',
      'TransientDispose.[Symbol.dispose] is never called: TransientDispose is transient and transient instances are not disposed by the container',
      'Lifecycle hook BaseWithHook.onStart must not have required parameters: it is called without arguments',
    ])
  })
})

describe('ZNIGHT010 / ZNIGHT014: unresolvable injections and async scopes', () => {
  it('reports every unresolvable injection type', async () => {
    const result = await analyzeFixture('unresolvable')
    expect(codes(result)).toEqual([
      'ZNIGHT014 src/types.ts:21:3',
      'ZNIGHT010 src/types.ts:31:5',
      'ZNIGHT010 src/types.ts:32:25',
      'ZNIGHT010 src/types.ts:33:23',
      'ZNIGHT010 src/types.ts:34:29',
      'ZNIGHT010 src/types.ts:35:23',
      'ZNIGHT010 src/types.ts:36:25',
      'ZNIGHT010 src/types.ts:37:41',
      'ZNIGHT010 src/types.ts:38:21',
      'ZNIGHT010 src/types.ts:39:14',
      'ZNIGHT010 src/types.ts:46:32',
    ])
    expect(renderDiagnostics(result.root, result.diagnostics)).toMatchSnapshot()
  })

  it('binds qualified value injections by kind (unknown matches any kind)', async () => {
    const result = await analyzeFixture('unresolvable')
    const node = result.graph.providers.find(candidate => candidate.token === 'src/types.ts#ValueInjection')
    expect(node?.deps.map(dep => dep.ref)).toEqual(['src/types.ts#Values.port', 'src/types.ts#Values.port'])
  })
})

describe('ZNIGHT019: unused providers', () => {
  it('is silent without reportUnused', async () => {
    const result = await analyzeFixture('unused')
    expect(result.diagnostics).toEqual([])
    expect(result.graph.reachability).toBeUndefined()
  })

  it('reports providers unreachable from roots', async () => {
    const result = await analyzeFixture('unused', { reportUnused: true })
    expect(result.graph.reachability).toEqual({
      roots: ['src/services.ts#PortAdapter', 'src/services.ts#ReferencedInMain', 'src/services.ts#Scheduler'],
      unreachable: ['src/services.ts#Orphan', 'src/services.ts#OrphanDependency', 'src/services.ts#OrphanParent'],
    })
    expect(codes(result)).toEqual([
      'ZNIGHT019 src/services.ts:18:14',
      'ZNIGHT019 src/services.ts:21:14',
      'ZNIGHT019 src/services.ts:24:14',
    ])
    expect(result.diagnostics.every(diagnostic => diagnostic.severity === 'warning')).toBe(true)
    expect(result.diagnostics[0]?.message).toBe('Orphan is never used: no root depends on it')
  })

  it('computes reachability for prune without reporting', async () => {
    const result = await analyzeFixture('unused', { prune: true })
    expect(result.diagnostics).toEqual([])
    expect(result.graph.reachability?.unreachable).toHaveLength(3)
  })
})

describe('ZNIGHT020: generated module imported by a provider module', () => {
  it('reports direct and transitive imports, ignores type-only imports and non-provider modules', async () => {
    const result = await analyzeFixture('generated')
    expect(codes(result)).toEqual(['ZNIGHT020 src/direct.service.ts:2:22', 'ZNIGHT020 src/user.service.ts:2:24'])
    expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'The provider module src/direct.service.ts imports the generated module src/.znight/container.generated.ts: src/direct.service.ts -> src/.znight/container.generated.ts',
      'The provider module src/user.service.ts imports the generated module src/.znight/container.generated.ts through src/helper.ts: src/user.service.ts -> src/helper.ts -> src/.znight/container.generated.ts',
    ])
  })

  it('follows a custom outFile', async () => {
    const result = await analyzeFixture('generated', { outFile: 'src/generated/metadata.ts' })
    expect(withCode(result, 'ZNIGHT020')).toEqual([])
  })
})

describe('ZNIGHT001 near-miss hints never contradict the registry', () => {
  it('does not suggest @Injectable() for a provider missed by its qualifier, nor for abstract or generic classes', async () => {
    const app = tempApp({
      'src/svc.ts': `
import { Inject, Injectable } from '@znight/core'

export interface User { readonly user: true }
export interface Order { readonly order: true }
export abstract class Repository<T> { abstract find(): T }
export class Box<T> { constructor(readonly value?: T) {} }

@Injectable() export class Service {}
@Injectable() export class OrderRepository extends Repository<Order> { find(): Order { return { order: true } } }

@Injectable()
export class Consumer {
  constructor(@Inject('main') readonly service: Service, readonly users: Repository<User>, readonly box: Box<User>) {}
}
`,
    })
    try {
      const result = await analyzeRoot(app.root)
      expect(codes(result)).toEqual([
        'ZNIGHT001 src/svc.ts:14:49',
        'ZNIGHT001 src/svc.ts:14:74',
        'ZNIGHT001 src/svc.ts:14:106',
      ])
      const [qualified, abstract, generic] = result.diagnostics.map(diagnostic => diagnostic.hints ?? [])
      expect(qualified).toEqual(["1 provider of Service exists but none is named 'main': Service (src/svc.ts:9)"])
      expect(abstract).toEqual([
        'Repository (src/svc.ts:6) is abstract: it cannot be a provider itself; decorate a concrete subclass of Repository<User> with @Injectable(), or provide Repository<User> with a @Provides method',
        'OrderRepository (src/svc.ts:10) implements Repository<Order>, not Repository<User>',
      ])
      expect(generic).toEqual([
        'Box (src/svc.ts:7) is generic: it cannot be a provider itself; decorate a concrete subclass of Box<User> with @Injectable(), or provide Box<User> with a @Provides method',
      ])
    } finally {
      app.cleanup()
    }
  })
})

describe('ZNIGHT005: decorators and providers the compiler cannot use', () => {
  it('reports a provider class exported as a type only (the generated module value-imports it)', async () => {
    const app = tempApp({
      'src/svc.ts': "import { Injectable } from '@znight/core'\n@Injectable()\nclass Svc {}\nexport type { Svc }\n",
      'src/both.ts':
        "import { Injectable } from '@znight/core'\n@Injectable()\nclass Both {}\nexport type { Both }\nexport { Both as Service }\n",
    })
    try {
      const result = await analyzeRoot(app.root)
      expect(codes(result)).toEqual(['ZNIGHT005 src/svc.ts:2:1'])
      expect(result.diagnostics[0]?.message).toBe(
        'Svc must be importable by the generated module to be a provider: it is exported as a type only',
      )
      expect(result.diagnostics[0]?.hints).toEqual(['Export it as a value: `export { Svc }` or `export class Svc ...`'])
      // a value export is preferred to a type-only one
      expect(provider(result, 'src/both.ts#Both').importRoute).toMatchObject({ exportName: 'Service', typeOnly: false })
    } finally {
      app.cleanup()
    }
  })

  it('warns about const aliases of Znight decorators, which are not followed', async () => {
    const app = tempApp({
      'src/deco.ts':
        "import { Injectable } from '@znight/core'\nexport const Service = Injectable\nexport const Again = (Service as typeof Injectable)\n",
      'src/svc.ts':
        "import { Again, Service } from './deco.ts'\n@Service()\nexport class Svc {}\n@Again()\nexport class Other {}\n",
    })
    try {
      const result = await analyzeRoot(app.root)
      expect(codes(result, 'warning')).toEqual(['ZNIGHT005 src/svc.ts:2:1', 'ZNIGHT005 src/svc.ts:4:1'])
      expect(renderDiagnostics(result.root, result.diagnostics)).toBe(
        [
          'warning ZNIGHT005 src/svc.ts:2:1: @Service is an alias of the Znight decorator @Injectable: aliases are not visible to the compiler, the decorator is ignored',
          "  = hint: Apply @Injectable(...) directly, or re-export it under another name: `export { Injectable as Service } from '@znight/core'`",
          '  - Service is declared in src/deco.ts (src/deco.ts:2:14)',
          'warning ZNIGHT005 src/svc.ts:4:1: @Again is an alias of the Znight decorator @Injectable: aliases are not visible to the compiler, the decorator is ignored',
          "  = hint: Apply @Injectable(...) directly, or re-export it under another name: `export { Injectable as Again } from '@znight/core'`",
          '  - Again is declared in src/deco.ts (src/deco.ts:3:14)',
        ].join('\n'),
      )
    } finally {
      app.cleanup()
    }
  })

  it('reports decorator arguments whose bigint evaluation throws in JavaScript', async () => {
    const app = tempApp({
      'src/svc.ts':
        "import { Injectable } from '@znight/core'\nconst N = 2n ** -1n\n@Injectable({ name: `svc-${N}` })\nexport class Svc {}\n",
    })
    try {
      const result = await analyzeRoot(app.root)
      expect(codes(result)).toEqual(['ZNIGHT005 src/svc.ts:3:28'])
    } finally {
      app.cleanup()
    }
  })
})

describe('ZNIGHT020 without the generated module on disk', () => {
  it('reports an import through a tsconfig `paths` alias on the first compile', async () => {
    const app = tempApp({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, experimentalDecorators: true, paths: { '@/*': ['./src/*'] } },
      }),
      'src/svc.ts':
        "import { Injectable } from '@znight/core'\nimport metadata from '@/.znight/container.generated.ts'\n@Injectable()\nexport class Svc {\n  readonly metadata = metadata\n}\n",
      'src/other.ts': "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Other {}\n",
      'src/nested/thing.ts':
        "import { Injectable } from '@znight/core'\nimport '@/nested/container.generated.ts'\nimport '#unknown/.znight/container.generated.ts'\n@Injectable()\nexport class Thing {}\n",
    })
    try {
      expect(fs.existsSync(`${app.root}/src/.znight/container.generated.ts`)).toBe(false)
      const result = await analyzeRoot(app.root)
      expect(codes(result)).toEqual(['ZNIGHT020 src/svc.ts:2:22'])
    } finally {
      app.cleanup()
    }
  })
})
