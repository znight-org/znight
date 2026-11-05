/**
 * Analysis of custom parameter decorators on routes (RFC 0010): one decorator per parameter, the
 * transport, uses outside routes, and the stored data.
 */
import { analyzeApp, cleanupApps, httpDiagnostics, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const DECORATORS = `import { createParamDecorator } from '@znight/core'
import type { HttpContext } from '@znight/http'

export interface User { readonly id: string }
export const CurrentUser = createParamDecorator<User>({ http: (ctx: HttpContext) => ctx.state.get('user') as User })
export const GraphqlOnly = createParamDecorator<User>({ graphql: () => ({ id: 'g' }) } as never)
`

describe('custom parameter decorators on routes', () => {
  it('stores custom parameters and reports invalid uses', async () => {
    const app = tempApp({
      'src/decorators.ts': DECORATORS,
      'src/app.ts': `import { Controller, Get, Query } from '@znight/http'
import { CurrentUser, GraphqlOnly, type User } from './decorators.ts'

@Controller('/x')
export class XController {
  @Get('/a')
  a(@CurrentUser() user: User) {
    return user
  }

  @Get('/b')
  b(@CurrentUser() @Query('q') user: User, @GraphqlOnly() other: User) {
    return [user, other]
  }

  helper(@CurrentUser() user: User) {
    return user
  }
}
`,
    })
    const result = await analyzeApp(app.root)
    expect(httpDiagnostics(result)).toEqual([
      "error ZNIGHT005 src/app.ts:12:20 Parameter 'user' of XController.b has several parameter decorators (@CurrentUser and @Query)",
      "error ZNIGHT005 src/app.ts:12:44 @GraphqlOnly has no 'http' resolver: it cannot be used on parameter 'other' of XController.b()",
      "error ZNIGHT005 src/app.ts:16:10 @CurrentUser cannot be used on parameter 'user' of XController.helper(): a custom parameter decorator decorates a parameter of a handler (a route of a @Controller, a field of a @Resolver, a message handler of a @Consumer)",
    ])
    const route = result.controllers[0]?.routes.find(candidate => candidate.handler === 'a')
    expect(route?.complete).toBe(true)
    expect(route?.params[0]).toMatchObject({
      index: 0,
      source: 'custom',
      key: 'CurrentUser',
      custom: { identity: 'src/decorators.ts#CurrentUser', name: 'CurrentUser', data: undefined, cast: false },
    })
    expect(result.controllers[0]?.routes.find(candidate => candidate.handler === 'b')?.complete).toBe(false)
  })
})
