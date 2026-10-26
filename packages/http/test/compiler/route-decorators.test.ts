/**
 * User-defined route metadata decorators (`createRouteDecorator<T>(key)`): resolution of the
 * decorator declaration and static evaluation of its argument.
 */
import { analyzeApp, cleanupApps, httpDiagnostics, tempApp } from './helpers.ts'
import { afterAll, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

it('resolves route decorators through renamed imports, namespaces, barrels and const keys', async () => {
  const app = tempApp({
    'src/auth/keys.ts': `
export const KEYS = { roles: 'roles', scopes: 'scopes' } as const
`,
    'src/auth/decorators.ts': `
import * as http from '@znight/http'
import { createRouteDecorator as route } from '@znight/http'
import { KEYS } from './keys.ts'
export const Roles = route<readonly string[]>(KEYS.roles)
export const Scopes = http.createRouteDecorator<readonly string[]>(\`\${KEYS.scopes}\`)
export const Public = (http.createRouteDecorator('public'))
export const Limit = route<{ readonly rpm: number }>('limit') satisfies http.RouteDecorator<{ readonly rpm: number }>
`,
    'src/auth/index.ts': `
export * from './decorators.ts'
`,
    'src/log.ts': `
export function Log(): MethodDecorator {
  return () => {}
}
export const NotARoute = (key: string) => key
`,
    'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import * as auth from './auth/index.ts'
import { Public as Open, Roles } from './auth/index.ts'
import { Log } from './log.ts'

const RPM = 60

@Controller('/app')
@Roles(['admin', 'ops'])
@auth.Scopes(['read'])
export class AppController {
  @Get()
  @Open()
  @Log()
  @auth.Limit({ rpm: RPM * 2 })
  @Roles(['user'] as const)
  index() { return 'ok' }
}
`,
  })
  const result = await analyzeApp(app.root)
  expect(httpDiagnostics(result)).toEqual([])
  const [controller] = result.controllers
  expect(controller?.meta.map(entry => [entry.key, entry.value])).toEqual([
    ['roles', ['admin', 'ops']],
    ['scopes', ['read']],
  ])
  expect(controller?.routes[0]?.meta.map(entry => [entry.key, entry.value])).toEqual([
    ['public', true],
    ['limit', { rpm: 120 }],
    ['roles', ['user']],
  ])
})

it('route decorators declared without initializer (declaration files) are reported', async () => {
  const app = tempApp({
    'node_modules/@acme/auth/package.json': JSON.stringify({
      name: '@acme/auth',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    }),
    'node_modules/@acme/auth/index.d.ts': `
import type { RouteDecorator } from '@znight/http'
export declare const Scopes: RouteDecorator<readonly string[]>
export declare const Other: (value: string) => MethodDecorator
`,
    'node_modules/@acme/auth/index.js': `
import { createRouteDecorator } from '@znight/http'
export const Scopes = createRouteDecorator('scopes')
export const Other = () => () => {}
`,
    'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Other, Scopes } from '@acme/auth'

@Controller('/app')
export class AppController {
  @Get()
  @Scopes(['read'])
  @Other('x')
  index() { return 'ok' }
}
`,
  })
  const result = await analyzeApp(app.root)
  expect(httpDiagnostics(result)).toEqual([
    'error ZNIGHT005 src/app.controller.ts:8:3 Invalid route decorator @Scopes: the key of the route decorator Scopes cannot be read: it is declared without initializer',
  ])
  expect(result.controllers[0]?.routes[0]?.meta).toEqual([])
})
