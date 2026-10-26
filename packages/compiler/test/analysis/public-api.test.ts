/**
 * The public entry: an extension written like the README example (type-only imports from the
 * package root) type-checks and works; runtime exports are present.
 */
import type { CompilerExtension, GenerateContext, GenNode } from '../../src/index.ts'

import * as compiler from '../../src/index.ts'
import { createGenBuilders } from '../../src/index.ts'
import { analyzeRoot, provider, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

interface Route {
  token: string
  path: string
  handler: string
}

const extension = {
  apiVersion: 1,
  name: 'acme-http',
  decorators: {
    '@acme/http#Controller': { targets: ['class'], params: ['static'] },
    '@acme/http#Get': { targets: ['method'], params: ['static'] },
    '@acme/http#UseGuard': { targets: ['class', 'method'], params: [], rest: 'value' },
  },
  analyzeClass(cls, ctx) {
    const controller = cls.decorators.find(d => d.identity === '@acme/http#Controller')
    if (!controller) return
    const token = ctx.registerProvider(cls)
    for (const guard of cls.decorators.filter(d => d.identity === '@acme/http#UseGuard').flatMap(d => d.args)) {
      ctx.resolveClassRef(guard, { from: cls, role: 'guard' })
    }
    for (const method of cls.methods) {
      const get = method.decorators.find(d => d.identity === '@acme/http#Get')
      if (get) ctx.store({ token, path: String(get.args[0]?.value ?? '/'), handler: method.name })
    }
  },
  generate(ctx) {
    return ctx.obj({ routes: ctx.arr(ctx.stored.map(route => ctx.obj({ path: route.path, handler: route.handler }))) })
  },
} satisfies CompilerExtension<Route>

describe('public API', () => {
  const app = tempApp({
    'node_modules/@acme/http/package.json': JSON.stringify({
      name: '@acme/http',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    }),
    'node_modules/@acme/http/index.d.ts': [
      'export declare function Controller(path?: string): ClassDecorator',
      'export declare function Get(path?: string): MethodDecorator',
      'export declare function UseGuard(...guards: unknown[]): ClassDecorator',
    ].join('\n'),
    'src/users.ts': `
import { Controller, Get, UseGuard } from '@acme/http'
export class AuthGuard {}
@Controller('/users')
@UseGuard(AuthGuard)
export class UserController {
  @Get('/:id') get(): void {}
}
`,
  })
  afterAll(() => app.cleanup())

  it('runs the README extension', async () => {
    const result = await analyzeRoot(app.root, { extensions: [extension] })
    expect(result.diagnostics).toEqual([])
    expect(provider(result, 'src/users.ts#UserController').registeredBy).toBe('acme-http')
    expect(provider(result, 'src/users.ts#AuthGuard').registeredBy).toBe('auto')
    const stored = result.graph.extensions[0]?.stored as Route[]
    expect(stored).toEqual([{ token: 'src/users.ts#UserController', path: '/:id', handler: 'get' }])
    const context = { ...createGenBuilders(), stored } as unknown as GenerateContext<Route>
    const node = extension.generate(context) as GenNode
    expect(node).toMatchObject({ kind: 'gen:object', entries: [['routes', { kind: 'gen:array' }]] })
  })

  it('exports the runtime API', () => {
    expect(Object.keys(compiler).sort()).toEqual([
      'COMPILER_VERSION',
      'DEFAULT_APP_ENTRY',
      'DEFAULT_EXCLUDE',
      'DEFAULT_INCLUDE',
      'DEFAULT_OUT_FILE',
      'DEFAULT_RUNTIME_CONDITIONS',
      'DEFAULT_SCAN_CONDITIONS',
      'EXTENSION_API_VERSION',
      'PROVIDERS_FILE',
      'PROVIDERS_SCHEMA_VERSION',
      'Project',
      'SOURCE_CONDITION',
      'ValueRef',
      'ZNIGHT_CONFIG_FILES',
      'analyze',
      'analyzeProject',
      'compile',
      'createCompiler',
      'createGenBuilders',
      'createPreload',
      'default',
      'discoverExtensionModules',
      'formatDiagnostics',
      'generate',
      'includeRoots',
      'isGenNode',
      'isRelevantChange',
      'loadExtensions',
      'loadZnightConfig',
      'normalizeOptions',
      'renderErrorModule',
      'validateExtension',
      'znight',
      'znightBunPlugin',
    ])
    expect(compiler.EXTENSION_API_VERSION).toBe(1)
  })
})
