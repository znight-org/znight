/**
 * Compiler extension loading (§6.5): auto-discovery through manifests, trust, apiVersion,
 * duplicate names, module formats, failures; and the extension API used by a test extension.
 */
import type { AnalyzeContext, ClassInfo, CompilerExtension } from '../../src/extensions/api.ts'

import { analyzeProject } from '../../src/analyze.ts'
import { createGenBuilders, isGenNode, isSafeIdentifier } from '../../src/extensions/generate.ts'
import { discoverExtensionModules, loadExtensions, validateExtension } from '../../src/extensions/loader.ts'
import { ValueRef } from '../../src/project/index.ts'
import { analyzeRoot, codes, fixtureProject, provider, renderDiagnostics, tempApp } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

describe('extension discovery', () => {
  it('finds compiler modules of the packages imported by the scanned code only', () => {
    const project = fixtureProject('extensions')
    expect(
      discoverExtensionModules(project).map(module => [module.packageName, module.specifier, module.trusted]),
    ).toEqual([
      ['@acme/ext', '@acme/ext/compiler', false],
      ['@znight/array-ext', '@znight/array-ext/compiler', true],
      ['@znight/bad-version', '@znight/bad-version/compiler', true],
      ['@znight/broken-ext', '@znight/broken-ext/compiler', true],
      ['@znight/conditional-ext', '@znight/conditional-ext/compiler', true],
      ['@znight/dup-a', '@znight/dup-a/compiler', true],
      ['@znight/dup-b', '@znight/dup-b/compiler', true],
      ['@znight/invalid-ext', '@znight/invalid-ext/compiler', true],
      ['@znight/missing-ext', '@znight/missing-ext/nope', true],
      ['@znight/throwing-ext', '@znight/throwing-ext/compiler', true],
    ])
  })

  it('trusts third-party packages listed in trustedExtensions', () => {
    const project = fixtureProject('extensions', { trustedExtensions: ['@acme/ext'] })
    expect(discoverExtensionModules(project)[0]?.trusted).toBe(true)
  })

  it('finds the extension owning a decorator re-exported by another package (preset)', async () => {
    const app = tempApp({
      'node_modules/@znight/web-ext/package.json': JSON.stringify({
        name: '@znight/web-ext',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': { types: './index.d.ts', default: './index.js' },
          './compiler': { default: './compiler.mjs' },
        },
        znight: { apiVersion: 1, compiler: '@znight/web-ext/compiler' },
      }),
      'node_modules/@znight/web-ext/index.d.ts': 'export declare function Route(path: string): ClassDecorator\n',
      'node_modules/@znight/web-ext/index.js': 'export const Route = () => () => {}\n',
      'node_modules/@znight/web-ext/compiler.mjs': `export default {
  apiVersion: 1,
  name: 'web',
  decorators: { '@znight/web-ext#Route': { targets: ['class'], params: ['static'] } },
  analyzeClass(cls, ctx) {
    ctx.registerProvider(cls)
  },
}
`,
      'node_modules/@acme/preset/package.json': JSON.stringify({
        name: '@acme/preset',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { types: './index.d.ts', default: './index.js' } },
      }),
      'node_modules/@acme/preset/index.d.ts': "export { Route } from '@znight/web-ext'\n",
      'node_modules/@acme/preset/index.js': "export { Route } from '@znight/web-ext'\n",
      'src/health.ts': "import { Route } from '@acme/preset'\n\n@Route('/health')\nexport class HealthController {}\n",
    })
    try {
      const result = await analyzeRoot(app.root)
      expect(
        discoverExtensionModules(result.project).map(module => [module.packageName, module.specifier, module.trusted]),
      ).toEqual([['@znight/web-ext', '@znight/web-ext/compiler', true]])
      expect(codes(result)).toEqual([])
      expect(result.extensions.map(entry => entry.extension.name)).toEqual(['web'])
      expect(provider(result, 'src/health.ts#HealthController').registeredBy).toBe('web')
    } finally {
      app.cleanup()
    }
  })
})

describe('extension loading', () => {
  it('loads trusted extensions and reports every problem as ZNIGHT018', async () => {
    const project = fixtureProject('extensions')
    const loaded = await loadExtensions(project, { sourceCondition: false })
    expect(loaded.extensions.map(entry => [entry.extension.name, entry.packageName])).toEqual([
      ['array-one', '@znight/array-ext'],
      ['array-two', '@znight/array-ext'],
      ['conditional-dist', '@znight/conditional-ext'],
      ['dup', '@znight/dup-a'],
      ['throwing', '@znight/throwing-ext'],
    ])
    expect(new Set(loaded.diagnostics.map(diagnostic => diagnostic.code))).toEqual(new Set(['ZNIGHT018']))
    expect(renderDiagnostics(project.root, loaded.diagnostics)).toMatchSnapshot()
  })

  it('locates loading problems at the "compiler" field of the package.json', async () => {
    const project = fixtureProject('extensions')
    const loaded = await loadExtensions(project, { sourceCondition: false })
    const untrusted = loaded.diagnostics.find(diagnostic => diagnostic.message.startsWith('@acme/ext'))
    expect(untrusted?.severity).toBe('warning')
    expect(untrusted?.location?.file).toBe(`${project.root}/node_modules/@acme/ext/package.json`)
    expect(untrusted?.location?.line).toBe(9)
  })

  it('resolves extension modules with the source condition under Bun', async () => {
    const project = fixtureProject('extensions')
    const names = async (sourceCondition?: boolean): Promise<string[]> =>
      (await loadExtensions(project, sourceCondition === undefined ? {} : { sourceCondition })).extensions.map(
        entry => entry.extension.name,
      )
    expect(await names(true)).toContain('conditional-source')
    expect(await names(false)).toContain('conditional-dist')
    expect(await names()).toContain('conditional-source') // the tests run under Bun
  })

  it('loads trusted third-party extensions', async () => {
    const result = await analyzeRoot(fixtureProject('extensions').root, { trustedExtensions: ['@acme/ext'] })
    expect(result.extensions.map(entry => entry.extension.name)).toContain('acme')
    expect(provider(result, 'src/marked.ts#AcmeMarked').registeredBy).toBe('acme')
    expect(result.graph.extensions.find(data => data.name === 'acme')?.stored).toEqual(['src/marked.ts#AcmeMarked'])
  })

  it('lets explicit extensions win over discovered ones with the same name', async () => {
    const explicit: CompilerExtension = { apiVersion: 1, name: 'dup', decorators: {} }
    const project = fixtureProject('extensions', { extensions: [explicit] })
    const loaded = await loadExtensions(project, { sourceCondition: false })
    const dup = loaded.extensions.filter(entry => entry.extension.name === 'dup')
    expect(dup).toHaveLength(1)
    expect(dup[0]?.origin).toBe('option')
    expect(loaded.diagnostics.some(diagnostic => diagnostic.message.includes("named 'dup'"))).toBe(false)
  })

  it('rejects invalid explicit extensions', async () => {
    const project = fixtureProject('extensions', {
      extensions: [{ apiVersion: 2, name: 'future' }],
    })
    const loaded = await loadExtensions(project, { sourceCondition: false, importModule: () => Promise.resolve({}) })
    expect(loaded.diagnostics[0]?.message).toBe(
      'Invalid compiler extension \'future\' in the "extensions" option: apiVersion 2 is not supported by this compiler (supported: 1)',
    )
  })

  it('reports extensions failing during analysis and validation, and decorator conflicts', async () => {
    const result = await analyzeRoot(fixtureProject('extensions').root)
    const messages = result.diagnostics.map(diagnostic => diagnostic.message)
    expect(messages).toContain("Compiler extension 'throwing' failed while analysing BoomMarked: analysis exploded")
    expect(messages).toContain("Compiler extension 'throwing' failed while validating: validation exploded")
    expect(messages).toContain(
      "Compiler extension 'throwing' declares the decorator @znight/core#Injectable, already owned by @znight/core",
    )
    // 'dup' (from @znight/dup-a) registers its class; the array extension does not analyse classes
    expect(result.graph.providers.map(node => node.token)).toEqual(['src/marked.ts#DupAMarked'])
  })
})

describe('validateExtension', () => {
  it('accepts a well-formed extension', () => {
    expect(
      validateExtension({
        apiVersion: 1,
        name: 'ok',
        decorators: { '@acme/x#Y': { targets: ['class', 'constructorParameter'], params: ['static'], rest: 'value' } },
        analyzeClass() {},
      }),
    ).toBeUndefined()
  })

  it.each([
    [null, 'not an object'],
    [{ apiVersion: 1 }, 'missing "name"'],
    [{ apiVersion: '1', name: 'x', decorators: {} }, 'apiVersion "1" is not supported by this compiler (supported: 1)'],
    [{ apiVersion: 1, name: 'x' }, '"decorators" must be an object keyed by canonical identities'],
    [
      { apiVersion: 1, name: 'x', decorators: { Get: { targets: ['method'], params: [] } } },
      'decorator key "Get" is not a canonical identity (\'<package>#<Export>\')',
    ],
    [
      { apiVersion: 1, name: 'x', decorators: { 'a#B': { targets: ['field'], params: [] } } },
      'decorator a#B: "targets" must be a non-empty array of class, method, property, parameter, constructorParameter',
    ],
    [
      { apiVersion: 1, name: 'x', decorators: { 'a#B': { targets: ['class'], params: ['lazy'] } } },
      "decorator a#B: \"params\" must be an array of 'static' | 'value'",
    ],
    [
      { apiVersion: 1, name: 'x', decorators: { 'a#B': { targets: ['class'], params: [], rest: 'x' } } },
      "decorator a#B: \"rest\" must be 'static' or 'value'",
    ],
    [{ apiVersion: 1, name: 'x', decorators: {}, validate: 'no' }, '"validate" must be a function'],
  ])('rejects %p', (value, problem) => {
    expect(validateExtension(value)).toBe(problem)
  })
})

describe('extension API', () => {
  const ID = '@acme/web#'
  const app = tempApp({
    'node_modules/@acme/web/package.json': JSON.stringify({
      name: '@acme/web',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
      znight: { apiVersion: 1, provides: [{ export: 'Request', plugin: 'WebPlugin', scope: 'request' }] },
    }),
    'node_modules/@acme/web/index.d.ts': [
      'export declare class Request { readonly url: string }',
      'export declare function Route(path: string, ...guards: unknown[]): ClassDecorator',
      'export declare function Handler(name: string): MethodDecorator',
      'export declare function Header(name: string): ParameterDecorator',
      'export declare function Bad(): ClassDecorator',
    ].join('\n'),
    'node_modules/@acme/web/index.js': 'export const Route = () => () => {}',
    'src/guards.ts': `
import { Injectable } from '@znight/core'
import type { Request } from '@acme/web'
export class Clock {}
@Injectable() export class SystemClock extends Clock {}
export class Guard { constructor(readonly clock: Clock) {} }
@Injectable({ scope: 'request' }) export class RequestGuard { constructor(readonly request: Request) {} }
export function notAClass(): void {}
export const PATH = '/web'
`,
    'src/routes.ts': `
import { Bad, Handler, Header, Route } from '@acme/web'
import { Guard, PATH, RequestGuard, notAClass } from './guards.ts'

@Route(PATH, Guard, notAClass, 'text')
export class WebController {
  @Handler('list')
  list(@Header('x-id') id: string): void {}
  @Route('/nested')
  wrongTarget(): void {}
}

@Bad()
export class Broken {}

@Route('/scoped', RequestGuard)
export class ScopedController {}
`,
  })

  const seen: ClassInfo[] = []
  const contexts: AnalyzeContext[] = []
  const extension: CompilerExtension<{ token: string; handle: number; guards: string[] }> = {
    apiVersion: 1,
    name: 'web',
    decorators: {
      [`${ID}Route`]: { targets: ['class'], params: ['static'], rest: 'value' },
      [`${ID}Handler`]: { targets: ['method'], params: ['static'] },
      [`${ID}Header`]: { targets: ['parameter'], params: ['static'] },
      [`${ID}Bad`]: { targets: ['class'], params: [] },
    },
    analyzeClass(cls, ctx) {
      seen.push(cls)
      contexts.push(ctx as AnalyzeContext)
      if (cls.decorators.some(decorator => decorator.identity === `${ID}Bad`)) {
        ctx.registerProvider(cls, { scope: 'eternal' as never })
        ctx.report({ code: 'ZNIGHT005', severity: 'error', message: 'Broken is broken', location: cls.location })
        return
      }
      const route = cls.decorators.find(decorator => decorator.identity === `${ID}Route`)
      if (!route) {
        return
      }
      const token = ctx.registerProvider(cls, { scope: 'singleton', name: cls.name.toLowerCase() })
      const guards = route.args
        .slice(1)
        .map(arg => ctx.resolveClassRef(arg, { from: cls, role: 'guard' })?.token)
        .filter(guard => guard !== undefined)
      const handle = ctx.bindInjection({ type: `${ID}Request`, label: `request of ${cls.displayName}` })
      ctx.addDependency(cls, `${ID}Request`, { reason: 'request access' })
      ctx.store({ token, handle: handle.id, guards })
    },
    validate(ctx) {
      for (const data of ctx.stored) {
        if (!ctx.provider(data.token)) {
          ctx.report({ code: 'ZNIGHT007', severity: 'error', message: `missing ${data.token}` })
        }
        if (ctx.binding({ id: data.handle }) !== `${ID}Request`) {
          ctx.report({ code: 'ZNIGHT007', severity: 'error', message: 'unbound request' })
        }
      }
    },
  }

  it('analyses every class carrying one of its decorators, with evaluated arguments', async () => {
    const result = await analyzeRoot(app.root, { extensions: [extension] })
    expect(seen.map(cls => cls.identity)).toEqual([
      'src/routes.ts#Broken',
      'src/routes.ts#ScopedController',
      'src/routes.ts#WebController',
    ])
    const web = seen.find(cls => cls.name === 'WebController') as ClassInfo
    const args = web.decorators[0]?.args ?? []
    expect(args[0]).toMatchObject({ kind: 'static', evaluated: true, value: '/web' })
    expect(args[1]?.ref).toBeInstanceOf(ValueRef)
    expect(args[3]).toMatchObject({ kind: 'value', evaluated: true, value: 'text' })
    expect(web.methods[0]?.params[0]?.decorators[0]).toMatchObject({ owner: 'web', args: [{ value: 'x-id' }] })
    expect(contexts[0]?.types.format({ kind: 'array', element: { kind: 'primitive', name: 'string' } })).toBe(
      'string[]',
    )

    expect(renderDiagnostics(result.root, result.diagnostics)).toMatchSnapshot()
  })

  it('registers providers, auto-registers guards and binds injections', async () => {
    const result = await analyzeRoot(app.root, { extensions: [extension] })
    expect(provider(result, 'src/routes.ts#WebController')).toMatchObject({
      registeredBy: 'web',
      name: 'webcontroller',
    })
    expect(provider(result, 'src/guards.ts#Guard')).toMatchObject({
      registeredBy: 'auto',
      deps: [expect.objectContaining({ ref: 'src/guards.ts#SystemClock' })],
    })
    expect(result.graph.extensions).toEqual([
      {
        name: 'web',
        stored: [
          { token: 'src/routes.ts#ScopedController', handle: 1, guards: ['src/guards.ts#RequestGuard'] },
          { token: 'src/routes.ts#WebController', handle: 2, guards: ['src/guards.ts#Guard'] },
        ],
      },
    ])
    expect([...result.graph.bindings]).toEqual([
      [1, '@acme/web#Request'],
      [2, '@acme/web#Request'],
    ])
    expect(
      result.graph.edges
        .filter(edge => edge.kind === 'extension')
        .map(edge => `${edge.from} -> ${edge.to} (${edge.label})`),
    ).toEqual([
      'src/routes.ts#ScopedController -> @acme/web#Request (request access)',
      'src/routes.ts#ScopedController -> src/guards.ts#RequestGuard (guard)',
      'src/routes.ts#WebController -> @acme/web#Request (request access)',
      'src/routes.ts#WebController -> src/guards.ts#Guard (guard)',
    ])
  })

  it('checks extension edges for scope mismatches and counts extension providers as roots', async () => {
    const result = await analyzeRoot(app.root, { extensions: [extension], reportUnused: true })
    expect(codes(result).filter(code => code.startsWith('ZNIGHT003'))).toEqual([
      'ZNIGHT003 src/routes.ts:5:1',
      'ZNIGHT003 src/routes.ts:16:1',
    ])
    expect(result.graph.reachability?.roots).toEqual([
      'src/routes.ts#Broken',
      'src/routes.ts#ScopedController',
      'src/routes.ts#WebController',
    ])
    expect(result.graph.reachability?.unreachable).toEqual([])
  })

  it('analysis is synchronous once extensions are loaded', () => {
    const project = fixtureProject('cycles')
    const result = analyzeProject(project, { extensions: [], diagnostics: [] })
    expect(result.stats).toMatchObject({ files: 5, classes: 8, providers: 10 })
  })
})

describe('code generation builders', () => {
  const g = createGenBuilders()

  it('builds frozen nodes from builders only', () => {
    const node = g.arrow(['c', 'ctx'], (c, ctx) => g.call(g.member(c, 'getUser'), [g.member(ctx, 'params', 'id'), 1]))
    expect(node).toEqual({
      kind: 'gen:arrow',
      params: [
        { name: 'c', type: undefined },
        { name: 'ctx', type: undefined },
      ],
      async: false,
      body: {
        kind: 'gen:call',
        new: false,
        callee: { kind: 'gen:member', object: { kind: 'gen:param', name: 'c' }, property: 'getUser' },
        args: [
          {
            kind: 'gen:member',
            object: { kind: 'gen:member', object: { kind: 'gen:param', name: 'ctx' }, property: 'params' },
            property: 'id',
          },
          { kind: 'gen:literal', value: 1 },
        ],
      },
    })
    expect(Object.isFrozen(node)).toBe(true)
    expect(isGenNode(node)).toBe(true)
  })

  it('builds blocks whose statements receive one parameter node per local', () => {
    const node = g.block(['a0'], a0 => [g.code`const ${a0} = ${1}`, g.code`return ${a0}`])
    expect(node).toEqual({
      kind: 'gen:block',
      locals: ['a0'],
      statements: [
        {
          kind: 'gen:code',
          parts: ['const ', ' = ', ''],
          values: [
            { kind: 'gen:param', name: 'a0' },
            { kind: 'gen:literal', value: 1 },
          ],
        },
        { kind: 'gen:code', parts: ['return ', ''], values: [{ kind: 'gen:param', name: 'a0' }] },
      ],
    })
    expect(Object.isFrozen(node)).toBe(true)
    expect(isGenNode(node)).toBe(true)
  })

  it('builds objects, arrays, literals, construct and code templates', () => {
    expect(g.obj({ a: 1, b: g.arr(['x', null]) })).toEqual({
      kind: 'gen:object',
      entries: [
        ['a', { kind: 'gen:literal', value: 1 }],
        [
          'b',
          {
            kind: 'gen:array',
            items: [
              { kind: 'gen:literal', value: 'x' },
              { kind: 'gen:literal', value: null },
            ],
          },
        ],
      ],
    })
    expect(g.lit({ nested: [1, 2n, undefined] })).toEqual({
      kind: 'gen:literal',
      value: { nested: [1, 2n, undefined] },
    })
    expect(g.construct(g.lit('X'), [])).toMatchObject({ kind: 'gen:call', new: true })
    const template = g.code`${g.lit('a')} ?? ${'b'}`
    expect(template).toEqual({
      kind: 'gen:code',
      parts: ['', ' ?? ', ''],
      values: [
        { kind: 'gen:literal', value: 'a' },
        { kind: 'gen:literal', value: 'b' },
      ],
    })
  })

  it('rejects raw strings, functions, cycles and invalid identifiers', () => {
    expect(() => g.code(['raw'] as unknown as TemplateStringsArray)).toThrow('tagged template')
    expect(() => g.lit((() => 1) as never)).toThrow('functions cannot be emitted')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => g.lit(cyclic as never)).toThrow('cyclic')
    expect(() => g.lit(new Map() as never)).toThrow('plain objects')
    expect(g.lit(new Date(0))).toEqual({ kind: 'gen:literal', value: new Date(0) })
    expect(g.lit(/x/g)).toEqual({ kind: 'gen:literal', value: /x/g })
    expect(() => g.lit({ [Symbol('k')]: 1 } as never)).toThrow('symbol keys')
    expect(() => g.arrow(['class'], () => 1)).toThrow('invalid parameter name')
    expect(() => g.arrow(['a', 'a'], () => 1)).toThrow('duplicate')
    expect(() => g.block(['let'], () => [])).toThrow('invalid local name')
    expect(() => g.block(['a', 'a'], () => [])).toThrow('duplicate block local')
    expect(() => g.block([], () => [{} as never])).toThrow('only accept nodes and primitives')
    expect(() =>
      g.obj([
        ['a', 1],
        ['a', 2],
      ]),
    ).toThrow('duplicate object key')
    expect(() => g.call(g.lit(1), [{} as never])).toThrow('only accept nodes and primitives')
    expect(() => g.ref({ text: 'x' } as never)).toThrow('not a reference')
    expect(isSafeIdentifier('valid$_1')).toBe(true)
    expect(isSafeIdentifier('1abc')).toBe(false)
  })
})
