import { createParamDecorator, type ParamFunctionOf, type ParamResolver } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

interface FakeContext {
  readonly state: Map<string, unknown>
}

interface OtherContext {
  readonly headers: Record<string, string>
}

declare module '../src/params.ts' {
  interface ParamContexts {
    fake: FakeContext
    other: OtherContext
  }
}

interface User {
  readonly id: string
}

class UserResolver implements ParamResolver<FakeContext, User> {
  resolve(ctx: FakeContext): User {
    return ctx.state.get('user') as User
  }
}

const CurrentUser = createParamDecorator<User>({ fake: ctx => ctx.state.get('user') as User })
const Claim = createParamDecorator<string, string>({ fake: (ctx, name) => String(ctx.state.get(name)) })
const MaybeClaim = createParamDecorator<string | undefined, string | undefined>({
  other: (ctx, name) => (name === undefined ? undefined : ctx.headers[name]),
})
const ByClass = createParamDecorator<User>({ fake: UserResolver })

class Controller {
  handle(
    @CurrentUser() _user: User,
    @Claim('sub') _sub: string,
    @MaybeClaim() _a: string | undefined,
    @MaybeClaim('x') _b: string | undefined,
    @ByClass() _c: User,
  ): void {
    // decorators are markers
  }
}

describe('createParamDecorator', () => {
  it('returns a no-op decorator and keeps the resolvers', () => {
    const ctx: FakeContext = {
      state: new Map<string, unknown>([
        ['user', { id: 'u1' }],
        ['sub', 42],
      ]),
    }
    expect(CurrentUser()).toBe(Claim('sub'))
    expect(typeof CurrentUser()).toBe('function')
    const resolve = CurrentUser.resolvers.fake as ParamFunctionOf<typeof CurrentUser, 'fake'>
    expect(resolve(ctx, undefined)).toEqual({ id: 'u1' })
    expect((Claim.resolvers.fake as ParamFunctionOf<typeof Claim, 'fake'>)(ctx, 'sub')).toBe('42')
    expect(ByClass.resolvers.fake).toBe(UserResolver)
    expect(new Controller().handle({ id: 'u' }, 's', undefined, undefined, { id: 'u' })).toBeUndefined()
  })

  it('freezes a copy of the resolvers', () => {
    const resolvers = { fake: (): User => ({ id: 'a' }) }
    const decorator = createParamDecorator<User>(resolvers)
    expect(Object.isFrozen(decorator.resolvers)).toBe(true)
    expect(decorator.resolvers).not.toBe(resolvers)
    expect(Object.keys(decorator.resolvers)).toEqual(['fake'])
  })

  it('types the data argument and the transports', () => {
    // @ts-expect-error no data argument when D is undefined
    CurrentUser('x')
    // @ts-expect-error the data argument is required
    Claim()
    // @ts-expect-error the data argument has type D
    Claim(1)
    // @ts-expect-error unknown transport
    createParamDecorator<User>({ websocket: () => ({ id: 'a' }) })
    // @ts-expect-error the resolver returns T
    createParamDecorator<User>({ fake: () => 'nope' })
    // @ts-expect-error the context is the transport's
    createParamDecorator<User>({ other: (ctx: FakeContext) => ctx.state.get('user') as User })
    createParamDecorator<User>({ fake: async () => ({ id: 'async' }) })
    expect(MaybeClaim.resolvers.other).toBeFunction()
  })
})
