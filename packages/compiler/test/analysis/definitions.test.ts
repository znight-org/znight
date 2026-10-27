/**
 * `definitionsOf(callee)` (analyze and validate contexts): the top-level constants of the scanned
 * files initialised with a call to a function, applied or not — e.g. every
 * `createRouteDecorator(key, { group, required })` of the application (RFC 0001).
 */
import type { CompilerExtension, DefinitionInfo } from '../../src/index.ts'

import { analyzeRoot, tempApp } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const CALLEE = '@acme/meta#defineMeta'

describe('definitionsOf', () => {
  it('lists the constants defined by a call, with evaluated arguments, type arguments and JSDoc', async () => {
    const app = tempApp({
      'node_modules/@acme/meta/package.json': JSON.stringify({
        name: '@acme/meta',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { types: './index.d.ts', default: './index.js' } },
      }),
      'node_modules/@acme/meta/index.d.ts': [
        'export interface MetaOptions { readonly group?: string; readonly required?: boolean }',
        'export declare function defineMeta<T = true>(key: string, options?: MetaOptions): (value?: T) => ClassDecorator',
        'export declare function other(key: string): unknown',
        'export declare function Marked(): ClassDecorator',
        '',
      ].join('\n'),
      'node_modules/@acme/meta/index.js': 'export const defineMeta = () => () => () => {}\n',
      'src/access.ts': `import { defineMeta, other } from '@acme/meta'
import * as meta from '@acme/meta'
import { Guard } from './guard.ts'

/** Routes anyone can call. */
export const Public = defineMeta('public', { group: 'access', required: true })
export const Roles = defineMeta<readonly string[]>('roles', { group: 'access', required: true }) satisfies unknown
const Internal = meta.defineMeta('internal')
export const NotACall = 'x'
export const Other = other('x')
export function inner(): unknown {
  const nested = defineMeta('nested')
  return nested
}
export const [destructured] = [defineMeta('d')]
const SPREAD = ['spread', { group: 'g' }] as const
export const Spread = defineMeta(...SPREAD)
export const Dynamic = defineMeta(String(Date.now()), { guard: Guard })
export { Internal }
`,
      'src/guard.ts': 'export class Guard {}\n',
      'src/controller.ts': `import { Marked } from '@acme/meta'
@Marked()
export class Controller {}
`,
    })
    let analyzed: readonly DefinitionInfo[] = []
    let validated: readonly DefinitionInfo[] = []
    const extension: CompilerExtension = {
      apiVersion: 1,
      name: 'meta',
      decorators: { '@acme/meta#Marked': { targets: ['class'], params: [] } },
      analyzeClass(_cls, ctx) {
        analyzed = ctx.definitionsOf(CALLEE)
        expect(ctx.definitionsOf('@acme/meta#nothing')).toEqual([])
      },
      validate(ctx) {
        validated = ctx.definitionsOf(CALLEE)
      },
    }
    try {
      const result = await analyzeRoot(app.root, { extensions: [extension] })
      expect(result.diagnostics).toEqual([])
      expect(validated).toBe(analyzed)
      expect(
        analyzed.map(definition => [
          definition.identity,
          definition.name,
          definition.exported,
          definition.location.line,
        ]),
      ).toEqual([
        ['src/access.ts#Dynamic', 'Dynamic', true, 18],
        ['src/access.ts#Internal', 'Internal', true, 8],
        ['src/access.ts#Public', 'Public', true, 6],
        ['src/access.ts#Roles', 'Roles', true, 7],
        ['src/access.ts#Spread', 'Spread', true, 17],
      ])
      const byName = new Map(analyzed.map(definition => [definition.name, definition]))
      const publicDefinition = byName.get('Public')
      expect(publicDefinition?.doc?.text).toBe('Routes anyone can call.')
      expect(publicDefinition?.args.map(arg => arg.value)).toEqual(['public', { group: 'access', required: true }])
      expect(publicDefinition?.call).toMatchObject({ line: 6, column: 23 })
      expect(publicDefinition?.typeArgs).toEqual([])
      expect(byName.get('Roles')?.typeArgs).toEqual([{ kind: 'array', element: { kind: 'primitive', name: 'string' } }])
      expect(byName.get('Spread')?.args.map(arg => arg.value)).toEqual(['spread', { group: 'g' }])
      const dynamic = byName.get('Dynamic')?.args ?? []
      expect(dynamic[0]).toMatchObject({ kind: 'value', evaluated: false })
      expect(dynamic[0]?.error).toBeDefined()
      expect(dynamic[1]?.value).toEqual({ guard: expect.objectContaining({ identity: 'src/guard.ts#Guard' }) })
      expect(byName.get('Internal')?.displayName).toBe('Internal')
    } finally {
      app.cleanup()
    }
  })

  it('rejects an invalid callee', async () => {
    const app = tempApp({
      'node_modules/@acme/meta/package.json': JSON.stringify({
        name: '@acme/meta',
        version: '1.0.0',
        types: './index.d.ts',
      }),
      'node_modules/@acme/meta/index.d.ts': 'export declare function Marked(): ClassDecorator\n',
      'src/a.ts': "import { Marked } from '@acme/meta'\n@Marked()\nexport class A {}\n",
    })
    const extension: CompilerExtension = {
      apiVersion: 1,
      name: 'meta',
      decorators: { '@acme/meta#Marked': { targets: ['class'], params: [] } },
      analyzeClass(_cls, ctx) {
        ctx.definitionsOf('' as never)
      },
    }
    try {
      const result = await analyzeRoot(app.root, { extensions: [extension] })
      expect(result.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.message])).toEqual([
        [
          'ZNIGHT018',
          "Compiler extension 'meta' failed while analysing A: [znight] definitionsOf(callee): callee must be a canonical identity",
        ],
      ])
    } finally {
      app.cleanup()
    }
  })
})
