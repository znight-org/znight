/**
 * Validation codes of the core analysis (§4.8): one fixture application per family in
 * `test/fixtures/analysis/<name>`. Near-miss and decorator messages are snapshotted.
 */
import { analyzeFixture, codes, renderDiagnostics, withCode } from './helpers.ts'
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
