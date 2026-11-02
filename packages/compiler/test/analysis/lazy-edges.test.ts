/**
 * Lazy extension edges (§6.5): `{ lazy: true }` on `bindInjection`, `addDependency` and
 * `resolveClassRef` declares a dependency the plugin resolves at call time in the current scope
 * (like `Lazy<T>`): it counts for ZNIGHT019 and `prune`, never for ZNIGHT003, ZNIGHT002 nor the
 * resolution order. Without `lazy`, extension edges keep their behaviour.
 */
import type { CompilerExtension } from '../../src/extensions/api.ts'

import { compile } from '../../src/compiler.ts'
import { analyzeRoot, codes, provider, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const ID = '@acme/graph#'

const app = tempApp({
  'node_modules/@acme/graph/package.json': JSON.stringify({
    name: '@acme/graph',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
  }),
  'node_modules/@acme/graph/index.d.ts': 'export declare function Resolver(...guards: unknown[]): ClassDecorator\n',
  'node_modules/@acme/graph/index.js': 'export const Resolver = () => () => {}\n',
  'src/request.ts': `
import { Injectable } from '@znight/core'
import { BookResolver } from './resolver.ts'

@Injectable({ scope: 'request' })
export class BookLoader {}

@Injectable({ scope: 'request' })
export class Audit {}

@Injectable({ scope: 'request' })
export class RequestGuard {}

/** Depends on the resolver: a cycle only through the lazy edges. */
@Injectable({ scope: 'request' })
export class Viewer {
  constructor(readonly resolver: BookResolver) {}
}
`,
  'src/resolver.ts': `
import { Resolver } from '@acme/graph'
import { RequestGuard } from './request.ts'

@Resolver(RequestGuard)
export class BookResolver {}
`,
})
afterAll(() => app.cleanup())

/** Binds a loader, a guard and an audit dependency from a singleton resolver, lazily or not. */
function extension(lazy: boolean | undefined): CompilerExtension<{ readonly handle: number }> {
  const options = lazy === undefined ? {} : { lazy }
  return {
    apiVersion: 1,
    name: 'graph',
    decorators: { [`${ID}Resolver`]: { targets: ['class'], params: [], rest: 'value' } },
    analyzeClass(cls, ctx) {
      ctx.registerProvider(cls)
      ctx.addRoot(cls, { reason: 'resolver' })
      for (const arg of cls.decorators[0]?.args ?? []) {
        ctx.resolveClassRef(arg, { from: cls, role: 'guard', ...options })
      }
      const handle = ctx.bindInjection(
        { type: 'src/request.ts#BookLoader', label: `loader of ${cls.displayName}` },
        { from: cls, ...options },
      )
      ctx.addDependency(cls, 'src/request.ts#Audit', { reason: 'audit', ...options })
      ctx.addDependency(cls, 'src/request.ts#Viewer', { reason: 'viewer', ...options })
      ctx.store({ handle: handle.id })
    },
  }
}

const RESOLVER = 'src/resolver.ts#BookResolver'

function edgesFrom(result: Awaited<ReturnType<typeof analyzeRoot>>): string[] {
  return result.graph.edges
    .filter(edge => edge.from === RESOLVER)
    .map(edge => `${edge.kind}${edge.extension ? ' (extension)' : ''} -> ${edge.to} (${edge.label})`)
}

describe('lazy extension edges', () => {
  it('declare lazy edges, marked as extension edges, without ZNIGHT003 nor ZNIGHT002', async () => {
    const result = await analyzeRoot(app.root, { extensions: [extension(true)], reportUnused: true })
    expect(codes(result)).toEqual([])
    expect(edgesFrom(result)).toEqual([
      'lazy (extension) -> src/request.ts#Audit (audit)',
      'lazy (extension) -> src/request.ts#BookLoader (loader of BookResolver)',
      'lazy (extension) -> src/request.ts#RequestGuard (guard)',
      'lazy (extension) -> src/request.ts#Viewer (viewer)',
    ])
    // the binding itself is unchanged: the plugin resolves the token in the scope of the call
    expect([...result.graph.bindings]).toEqual([[1, 'src/request.ts#BookLoader']])
    expect(result.graph.bindingRequests.get(1)).toMatchObject({ from: RESOLVER, lazy: true })
    expect(provider(result, RESOLVER).scope).toBe('singleton')
  })

  it('count for ZNIGHT019: what the resolver uses lazily is reachable', async () => {
    const result = await analyzeRoot(app.root, { extensions: [extension(true)], reportUnused: true })
    expect(result.graph.reachability?.roots).toEqual([RESOLVER])
    expect(result.graph.reachability?.unreachable).toEqual([])
  })

  it('keep the lazily used providers under prune', async () => {
    const result = await compile({
      root: app.root,
      extensions: [extension(true)],
      prune: true,
      conditions: ['@znight/source'],
    })
    expect(result.ok).toBe(true)
    expect(result.graph.providers.map(node => node.token)).toEqual([
      'src/request.ts#Audit',
      'src/request.ts#BookLoader',
      'src/request.ts#RequestGuard',
      'src/request.ts#Viewer',
      RESOLVER,
    ])
  })

  it('never take part in the resolution order', async () => {
    const lazy = await analyzeRoot(app.root, { extensions: [extension(true)] })
    const eager = await analyzeRoot(app.root, { extensions: [extension(false)] })
    expect(lazy.graph.resolutionOrder).toEqual(eager.graph.resolutionOrder)
    // the request-scoped Viewer depends on the resolver: it comes after it
    expect(lazy.graph.resolutionOrder.indexOf(RESOLVER)).toBeLessThan(
      lazy.graph.resolutionOrder.indexOf('src/request.ts#Viewer'),
    )
  })

  it('leave eager extension edges unchanged: ZNIGHT003 for a singleton using request-scoped providers', async () => {
    for (const lazy of [false, undefined]) {
      const result = await analyzeRoot(app.root, { extensions: [extension(lazy)], reportUnused: true })
      expect(codes(result)).toEqual(['ZNIGHT003 src/resolver.ts:5:1'])
      expect(edgesFrom(result)).toEqual([
        'extension -> src/request.ts#Audit (audit)',
        'extension -> src/request.ts#BookLoader (loader of BookResolver)',
        'extension -> src/request.ts#RequestGuard (guard)',
        'extension -> src/request.ts#Viewer (viewer)',
      ])
      expect(result.graph.bindingRequests.get(1)).not.toHaveProperty('lazy')
      expect(result.graph.reachability?.unreachable).toEqual([])
    }
  })

  it('ignore lazy without from: no edge', async () => {
    const unbound: CompilerExtension = {
      ...(extension(true) as CompilerExtension),
      analyzeClass(cls, ctx) {
        ctx.registerProvider(cls)
        ctx.bindInjection({ type: 'src/request.ts#BookLoader' }, { lazy: true })
      },
    }
    const result = await analyzeRoot(app.root, { extensions: [unbound], reportUnused: true })
    expect(edgesFrom(result)).toEqual([])
    expect(result.graph.bindingRequests.get(1)).not.toHaveProperty('lazy')
  })
})
