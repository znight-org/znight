---
description: Write your own parameter decorators such as @CurrentUser() with createParamDecorator, one resolver per transport (HTTP, GraphQL, messaging), checked at build time and called directly by the generated code.
---

# Custom parameter decorators

Every transport fills handler parameters with its own decorators: `@Param`, `@Query` and `@Body`
on HTTP routes, `@Args` and `@Parent` on GraphQL fields, `@Message` and `@Headers` on message
handlers. `createParamDecorator` from `@znight/core` adds yours: a `@CurrentUser()`, a `@Tenant()`,
a `@Claim('sub')`, defined once and usable on HTTP routes, GraphQL fields and message handlers
(RFC 0010).

```ts
import { createParamDecorator } from '@znight/core'
import { UnauthorizedException } from '@znight/http'
import type { User } from './user.ts'

/** The authenticated user, stored in the request state by the authentication guard. */
export const CurrentUser = createParamDecorator<User>({
  http: ctx => {
    const user = ctx.state.get('user') as User | undefined
    if (user === undefined) throw new UnauthorizedException()
    return user
  },
  graphql: ctx => ctx.operation.state.get('user') as User,
})
```

```ts
@Controller('/wishlists')
export class WishlistController {
  constructor(private readonly wishlists: WishlistService) {}

  @Get()
  list(@CurrentUser() user: User, @Query('page') page = 1) {
    return this.wishlists.listFor(user.id, { page })
  }
}
```

Like every Znight decorator, `@CurrentUser()` is a marker: the compiler reads it, and the generated
`invoke` of the route calls the resolver directly, among the other arguments. No reflection, no
lookup per request, and no promise when the resolver returns a value.

## The definition

`createParamDecorator<T, D>(resolvers)`:

- `T` (required) is the injected type. The compiler checks it against every decorated parameter.
- `D` is the type of the data argument. Without it the decorator takes no argument
  (`@CurrentUser()`); with a type that excludes `undefined` the argument is required
  (`@Claim('sub')`), otherwise optional.
- `resolvers` maps a transport to a resolver: `http` (it receives the `HttpContext`), `graphql` (the
  field's `ResolverContext`: `parent`, `args`, `info`, `operation`, `http`, `route.meta`) and
  `messaging` (the `InboundMessage`). Each transport package declares its key when it is installed,
  so `{ graphql: ... }` does not type-check in an application without `@znight/graphql`.
- The definition is an **exported** top-level `const`: the generated module imports it.

A resolver is a function `(ctx, data) => T`, or returns a promise of `T`: the handler then waits
for it, and the route stays synchronous for the resolvers that return a value.

```ts
import { createParamDecorator } from '@znight/core'
import type { User } from './user.ts'

export const Claim = createParamDecorator<string, keyof User>({
  http: (ctx, key) => String((ctx.state.get('user') as User)[key]),
})

// @Get('/me/name') name(@Claim('name') name: string) { ... }
```

The data argument follows the rules of the other `value` arguments: a literal, a `const`, an object
or array of them, or an exported binding (a Standard Schema, for instance). An inline expression the
compiler cannot evaluate (`@Claim(name())`) is a build error with the fix-it "extract to
`export const X = ...`".

## Resolvers with dependencies

A resolver that needs providers is the class of a provider implementing `ParamResolver`. It is
bound at build time like a guard (a class without decorator is registered as a singleton) and
resolved in the scope of the call: a request-scoped resolver is created once per request (HTTP),
operation (GraphQL) or delivery (messaging), and can memoize what it loads.

```ts
import type { ParamResolver } from '@znight/core'
import type { HttpContext } from '@znight/http'
import { createParamDecorator, Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'
import { UserRepository } from './user.repository.ts'
import type { User } from './user.ts'

@Injectable({ scope: 'request' })
export class CurrentUserResolver implements ParamResolver<HttpContext, User> {
  #user: Promise<User> | undefined

  constructor(private readonly users: UserRepository) {}

  resolve(ctx: HttpContext): Promise<User> {
    const id = ctx.state.get('userId') as string | undefined
    if (id === undefined) throw new UnauthorizedException()
    // several @CurrentUser() parameters of one request load the user once
    this.#user ??= this.users.findById(id).then(user => user ?? Promise.reject(new UnauthorizedException()))
    return this.#user
  }
}

export const CurrentUser = createParamDecorator<User>({ http: CurrentUserResolver })
```

The edge from the controller to the resolver is lazy: a singleton controller may use a
request-scoped resolver. The [Security guide](/guide/security#current-user) uses this form, on top
of the request-scoped holder its authentication guard fills.

## What the compiler checks

Every mistake that can be found at build time is a [`ZNIGHT005`](/reference/error-codes#znight005)
located on the use, with the definition as related location:

- the definition is not exported, has no type argument, or its resolvers are not an object literal
  of inline functions, function references or class references;
- the decorator is not called (`@CurrentUser` instead of `@CurrentUser()`), decorates a rest
  parameter, a constructor parameter or a method that is not a handler;
- the handler's transport has no resolver (`@CurrentUser has no 'messaging' resolver`);
- the parameter carries another parameter decorator (`@CurrentUser() @Body() x`);
- the data argument cannot be emitted;
- the parameter does not accept `T`. The most useful case is nullability: a decorator injecting
  `User | undefined` on a parameter typed `User` is an error, `user?: User` and `user: User = guest`
  accept it. The check is conservative: `any`, `unknown` and types the compiler cannot describe are
  not checked (the argument is then cast).

## Order and errors

The resolver runs inside `invoke`, in parameter order with the other arguments:

- **HTTP**: guards, body parsing, interceptors, then `invoke`. A resolver sees what the guards stored
  in `ctx.state` and the route metadata (`Roles.get(ctx)`); the body is parsed beforehand only when
  the route has a `@Body()` or upload parameter (`await ctx.parseBody()` otherwise).
- **GraphQL**: guards (the same `ResolverContext`), null handling of arguments, then `invoke`.
- **Messaging**: the `messaging:message` hook, then `invoke`.

What a resolver throws fails the handler as if the handler had thrown: exception mappers and
`HttpException`s over HTTP (an `UnauthorizedException` answers `401`), `errors[]` or a result
mapper in GraphQL, retries and dead letters for messages.

There are no pipes: a resolver validates what it returns with the helpers of each package
(`validate(schema, value, label)` of `@znight/http` answers `400`, like `@Body(S)`), and a schema
can be the data argument.

## Testing

- `TestBed` calls methods directly: decorators do nothing, pass the value
  (`controller.list(user, 1)`).
- `TestApp` runs the whole pipeline, resolvers included. Class resolvers can be replaced like any
  provider: `overrides: [override(CurrentUserResolver, createMock(CurrentUserResolver, { resolve: async () => alice }))]`.
- Resolver functions are plain functions: `CurrentUser.resolvers.http` can be called from a test.

## Performance

Handlers without custom parameters are generated exactly as before. A function resolver costs one
property read and one call, with no closure and no promise when it returns a value; class resolvers
are passed to `invoke` as one array resolved at boot when they are all singletons, otherwise
resolved in the scope of the call. GraphQL builds the `ResolverContext` only for fields that have
custom parameters.

## Limits

- Definitions are read from sources: a provider library publishing them must publish its sources
  (`"znight": { "library": "source" }`).
- Custom parameters are not documented by `@znight/openapi`: describe the header or cookie a
  decorator reads with `@ApiHeader` or `@ApiSecurity`.
- Composing decorators (`applyDecorators`) is not supported: apply each decorator directly.
