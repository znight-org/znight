# RFC 0010: Custom parameter decorators

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Accepted (v0.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Date     | 2026-11-04                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Affects  | `@znight/core` (the `createParamDecorator` factory and its types), `@znight/compiler` (recognition of the definitions, an extension API to read their uses, an assignability helper), `@znight/http`, `@znight/graphql` and `@znight/messaging` (analysis, generated `invoke`, metadata of the handlers, runtime pipelines), `@znight/openapi` (custom parameters are not documented), `@znight/testing` (docs only). No new error code: ZNIGHT005 is reused                                                                             |
| Decision | **One factory in `@znight/core`, one resolver per transport.** `export const CurrentUser = createParamDecorator<User>({ http: ctx => ..., graphql: ctx => ... })`. The compiler recognises the `const`, checks every use (target, transport, data argument, declared type against the parameter type) at build time, and the generated `invoke` calls the resolver directly: a function, or the `resolve()` method of a provider bound at build time. Synchronous until a resolver returns a promise; handlers without one are unchanged |

## 1. Summary

Every transport of Znight fills handler parameters with decorators it owns: `@Param`, `@Query`,
`@Body`, `@Headers`, `@Cookie`, `@Ctx` for HTTP routes, `@Args`, `@Parent`, `@Ctx`, `@Info`,
`@Loader` for GraphQL resolvers, `@Message`, `@Headers`, `@Ctx` for message handlers. The compiler
extension of each package reads them and generates one `invoke` arrow per handler that computes the
arguments. There is no way for an application to add its own: the `@CurrentUser()` that almost
every NestJS, Spring or TypeGraphQL application has cannot be written. The workaround is a
request-scoped provider (§9.1), which works but moves the value out of the handler signature.

This RFC adds user-defined parameter decorators that keep the principles of Znight: a decorator is a
marker read from the AST, the value it injects is computed by a plain function (or a provider)
called from generated code, and every mistake that can be found at build time is a located
ZNIGHT005.

```ts
// src/auth/current-user.ts
import { createParamDecorator } from '@znight/core'
import { UnauthorizedException } from '@znight/http'
import type { User } from './user.ts'

/** The authenticated user, set in the request state by AuthGuard. */
export const CurrentUser = createParamDecorator<User>({
  http: ctx => userOf(ctx.state),
  graphql: ctx => userOf(ctx.operation.state),
})

function userOf(state: Map<string | symbol, unknown>): User {
  const user = state.get('user') as User | undefined
  if (user === undefined) throw new UnauthorizedException()
  return user
}
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

@Resolver()
export class WishlistResolver {
  constructor(private readonly wishlists: WishlistService) {}

  @Query()
  myWishlists(@CurrentUser() user: User): Promise<Wishlist[]> {
    return this.wishlists.listFor(user.id)
  }
}
```

The generated `invoke` of the route calls the resolver function, with no closure, and stays
synchronous (no promise, no `await`) when the resolver returns a value:

```ts
invoke: (c: WishlistController, ctx: HttpContext) => {
  const a0 = CurrentUser.resolvers.http(ctx, undefined)
  if (isThenable(a0)) {
    return (async () => c.list(await a0, coerce.optional(ctx.query['page'], 'query "page"', coerce.number)))()
  }
  return c.list(a0, coerce.optional(ctx.query['page'], 'query "page"', coerce.number))
},
```

## 2. How the ecosystem does it

### 2.1 NestJS: `createParamDecorator`

```ts
export const CurrentUser = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest()
  return request.user
})
```

- The factory receives the decorator argument (`data`) and an `ExecutionContext`, a
  transport-neutral wrapper: `switchToHttp()`, `switchToRpc()`, `switchToWs()`, and for GraphQL
  `GqlExecutionContext.create(ctx).getContext()`. Applications that serve HTTP and GraphQL commonly
  end up with two decorators (`@CurrentUser()` and `@GqlCurrentUser()`), or one factory branching on
  `ctx.getType()`.
- Everything happens at runtime: the decorator stores the factory in the route metadata
  (`reflect-metadata`), the router reads it and calls it for every request.
- `createParamDecorator<string>(...)` types the **data** argument only. Nothing checks that the
  value matches the type of the decorated parameter: `@CurrentUser() user: Admin` compiles.
- Pipes apply to the value: `@CurrentUser(new ValidationPipe({ validateCustomDecorators: true }))`.
  The global `ValidationPipe` skips custom decorators unless `validateCustomDecorators` is set.
- The factory cannot inject providers. Dependency injection goes through pipes (pipe classes are
  injectable) or through a guard that stores the result on the request, which the factory then
  reads. The documentation only shows synchronous factories; asynchronous work (loading the user)
  is usually done in a guard or an interceptor.
- `applyDecorators()` composes decorators.

### 2.2 Spring: `HandlerMethodArgumentResolver`, `@AuthenticationPrincipal`

```java
public class CurrentTenantResolver implements HandlerMethodArgumentResolver {
  public boolean supportsParameter(MethodParameter parameter) {
    return parameter.hasParameterAnnotation(CurrentTenant.class);
  }
  public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mav,
      NativeWebRequest request, WebDataBinderFactory binders) { ... }
}
```

- A resolver is a **bean** (constructor injection), registered through
  `WebMvcConfigurer.addArgumentResolvers`. It receives the parameter description
  (`MethodParameter`: type, annotations, generics), so the annotation carries the data.
- `@AuthenticationPrincipal` is the canonical example. It is supported by Spring MVC, WebFlux
  (where the resolver returns a `Mono`) and Spring for GraphQL controllers: **one annotation, one
  resolver per transport**. It checks the principal against the parameter type at runtime
  (`errorOnInvalidType`, otherwise `null`).

### 2.3 Micronaut: argument binders

`TypedRequestArgumentBinder<T>` (bound by type) and `AnnotatedRequestArgumentBinder<A, T>` (bound by
annotation) are beans returning a `BindingResult<T>`; Micronaut Security binds `Authentication` and
`Principal` this way. Micronaut computes the argument metadata ahead of time (bean introspection),
but the binder lookup and the call happen at runtime.

### 2.4 TypeGraphQL and routing-controllers

- TypeGraphQL 2: `createParameterDecorator<Context>(({ root, args, context, info }) => ...)` (named
  `createParamDecorator` before 2.0). The resolver gets the four values of a graphql-js resolver
  and may return a promise. It is wrapped by a function the user exports
  (`export function CurrentUser() { return createParameterDecorator(...) }`), so arguments are free.
- routing-controllers: `createParamDecorator({ required, value: action => ... })`, where `action`
  holds the request and the response; `value` may return a promise, `required` turns `undefined`
  into an error.

### 2.5 Elsewhere

FastAPI's `Depends(get_current_user)` is the closest to dependency injection: a dependency is a
function, possibly `async`, that itself declares dependencies, cached per request. ASP.NET Core has
model binders (`IModelBinder`) and `[FromServices]` for parameters filled by the container. Hono and
Express applications set a value on the context in a middleware (`c.set('user', user)`) and read it
in the handler.

### 2.6 What users expect

| Expectation                    | Nest        | Spring        | Micronaut | TypeGraphQL | routing-controllers | This RFC                                       |
| ------------------------------ | ----------- | ------------- | --------- | ----------- | ------------------- | ---------------------------------------------- |
| A data argument                | yes         | annotation    | yes       | free        | free                | yes, statically evaluated or exported (§4.4)   |
| Access to the request context  | yes         | yes           | yes       | yes         | yes                 | yes, the context of each transport (§4.3)      |
| One decorator, many transports | `getType()` | per transport | partly    | GraphQL     | HTTP                | yes, one resolver per transport (§4.2)         |
| Asynchronous resolution        | via pipes   | WebFlux       | yes       | yes         | yes                 | yes, promise awaited only when returned (§4.7) |
| Dependency injection           | pipes only  | yes (beans)   | yes       | no          | no                  | yes, provider resolvers (§4.6)                 |
| Validation / pipes             | pipes       | `@Valid`      | yes       | no          | no                  | in the resolver, schema as data (§4.10)        |
| Value type checked             | no          | runtime       | runtime   | no          | no                  | **build time** (§4.5)                          |

## 3. Goals and non-goals

Goals:

- Let applications and provider libraries write `@CurrentUser()`, `@Tenant()`, `@Claim('sub')`,
  `@Locale()`, `@ClientIp()` once and use them on HTTP routes, GraphQL fields and message handlers.
- Keep decorators as markers: no reflection, no runtime lookup of what a parameter needs.
- Find at build time what can be found there: the decorator on the wrong target, on a transport it
  does not support, a data argument that cannot be emitted, a value type that the parameter does not
  accept.
- Allow resolvers that need providers (a user repository, a tenant registry), in any scope.
- Zero cost for handlers that do not use custom decorators: their generated code stays
  byte-identical. Handlers that do pay one property read and one call per custom parameter.

Non-goals:

- Pipes (value transformers attached to a parameter). Validation stays a Standard Schema concern
  (§4.10).
- Composing decorators (`applyDecorators`): a decorator stays one marker; composite decorators keep
  their ZNIGHT005 warning (specification §4.6).
- Method injection of arbitrary providers into handler parameters (`@Inject() users: UserService`).
  It could be built on the same mechanism later (§10, Q8).
- Custom decorators for constructor parameters, properties or classes.

## 4. Design

### 4.1 User-facing API

```ts
// @znight/core
export function createParamDecorator<T, D = undefined>(resolvers: ParamResolvers<T, D>): ParamDecorator<T, D>
```

- `T` is the value injected in the parameter. It is **required** (a type argument the compiler
  reads, §4.5).
- `D` is the type of the data argument. With the default `undefined`, the decorator takes no
  argument: `@CurrentUser()`. With `D` a type that excludes `undefined`, the argument is required:
  `@Claim('sub')`. With `D` including `undefined`, it is optional.
- `resolvers` maps a **transport name** to a resolver. Each transport package declares its name and
  its context type by augmenting an interface of `@znight/core`:

```ts
// @znight/core
/** Resolver contexts by transport; each transport package adds its own entry (declaration merging). */
export interface ParamContexts {}

/** Computes the value of a parameter: a function, or the class of a provider implementing ParamResolver. */
export type ParamResolverOf<C, T, D> = ((ctx: C, data: D) => T | PromiseLike<T>) | ParamResolverClass<C, T, D>

export interface ParamResolver<C, T, D = undefined> {
  resolve(ctx: C, data: D): T | PromiseLike<T>
}

/** The class of a provider resolving parameters (bound at build time, resolved in the scope of the call). */
export type ParamResolverClass<C, T, D> = abstract new (...args: never[]) => ParamResolver<C, T, D>

export type ParamResolvers<T, D> = { readonly [K in keyof ParamContexts]?: ParamResolverOf<ParamContexts[K], T, D> }

/** What createParamDecorator returns: the decorator (a no-op marker), and its resolvers for generated code. */
export interface ParamDecorator<T, D, R extends ParamResolvers<T, D> = ParamResolvers<T, D>> {
  (...data: undefined extends D ? [data?: D] : [data: D]): ParameterDecorator
  readonly resolvers: R
}
```

```ts
// @znight/http (likewise @znight/graphql and @znight/messaging)
declare module '@znight/core' {
  interface ParamContexts {
    http: HttpContext
  }
}
```

The real signature captures the literal type of `resolvers` (`R`), so `CurrentUser.resolvers.http`
is typed as present when the definition has an `http` entry; generated code needs no `!`.
Augmentation through `declare module` is erasable syntax, so it stays within the rules of
`packages/*/src`. A transport that is not installed has no entry, so `{ graphql: ... }` does not even
type-check in an application without `@znight/graphql`.

Like every Znight decorator, the function returned by `createParamDecorator` returns the shared
no-op function. `resolvers` is frozen.

### 4.2 One decorator, several transports

A decorator supports the transports it has a resolver for. Using it on a handler of a transport it
does not support is ZNIGHT005 at build time:

```txt
error ZNIGHT005: @CurrentUser has no 'messaging' resolver: it cannot be used on parameter 'user' of OrderConsumer.placed()
  --> src/orders/order.consumer.ts:14:10
  hint: add a messaging resolver to the definition: createParamDecorator<User>({ ..., messaging: message => ... })
  related: @CurrentUser is defined in src/auth/current-user.ts:6:14
```

This follows Spring (`@AuthenticationPrincipal` has one resolver per stack) rather than Nest (one
factory switching on `ExecutionContext.getType()`): each resolver gets the precise, typed context of
its transport, the compiler knows which transports a decorator supports, and no transport pays for
the others. One resolver can serve several transports when the contexts share what it reads (the
`userOf` helper of §1, or a provider class whose `resolve` accepts a union of contexts).

A definition may hold resolvers for transports that no handler uses; nothing is reported. A key no
loaded compiler extension claims is ignored by the compiler (the type-check already rejects keys no
package declares).

### 4.3 The context of each transport

| Transport (key) | Context passed to the resolver | What it gives                                                                                           |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `http`          | `HttpContext`                  | Request, `state` set by guards, `route.meta` (route decorators: `Roles.get(ctx)`), cookies, `requestId` |
| `graphql`       | `ResolverContext`              | `parent`, `args`, `info`, `operation` (the `GraphQLContext`: `state`, `loader()`), `http`, `route.meta` |
| `messaging`     | `InboundMessage`               | Payload, headers, attempt, the delivery                                                                 |
| `websocket`     | (RFC 0003, when it lands)      | The connection context of a gateway event                                                               |

GraphQL resolvers get the `ResolverContext` that guards already receive (RFC 0005 §5.9), not the
operation-wide `GraphQLContext`, because field-level values (the parent, the arguments, `info`) are
what TypeGraphQL-style decorators read. The pipeline already builds it for fields with guards; it
builds it for fields with custom parameters too, one instance shared by the guards and the
resolvers of a call (§4.13).

Third-party transports declare their key the same way, and read uses with the extension API of
§6.2.

### 4.4 Data argument

The argument of a use (`@Claim('sub')`, `@Permission(Permissions.Admin)`) is a **`value`** argument
in the sense of specification §4.6: evaluated statically when possible (literals, `const`
references, objects and arrays of them), otherwise a reference to an exported binding imported by
the generated module. A Standard Schema exported as a `const` is a valid data argument. An inline
expression that is neither (`@Claim(name())`) is ZNIGHT005 with the usual fix-it ("extract to
`export const X = ...`"). Without argument, the resolver receives `undefined`.

TypeScript checks the argument against `D` (the decorator is a typed function); the compiler only
checks that it can be emitted.

### 4.5 Build-time checks (normative)

A **definition** is a top-level `const` of a scanned file initialised with a call to
`@znight/core#createParamDecorator` (found with `definitionsOf`, specification §6.5). A **use** is a
decorator on a method parameter whose callee resolves to a definition. Every problem below is
ZNIGHT005 (error), located on the use, with the definition as related location when relevant:

1. **Definition shape.** The `const` is exported (the generated module imports it). The first
   argument is an object literal whose keys are identifiers or string literals (no spread, no
   computed key) and whose values are inline functions, references to functions, or references to
   classes. The type argument `T` is present. A definition read from a declaration file
   (`export declare const CurrentUser: ParamDecorator<User>`) cannot be analysed: the hint asks to
   publish the library's sources, like route decorators (Q4).
2. **Call form.** The decorator is called: `@CurrentUser()`, not `@CurrentUser`.
3. **Target.** A parameter of a handler owned by a transport extension: a route handler of a
   `@Controller`, a field method of a `@Resolver`, an `@OnMessage` method of a `@Consumer`. A use on a
   constructor parameter, a `@Provides` parameter or the parameter of a method no extension handles
   is reported once the analysis is complete (an unclaimed use, §6.2).
4. **Transport.** The definition has a resolver for the transport of the handler (§4.2).
5. **One parameter decorator.** A parameter carries one parameter decorator, built-in or custom
   (`@CurrentUser() @Body() x` is the existing "several decorators" error of each extension). Rest
   parameters cannot be decorated.
6. **Data.** The argument can be emitted (§4.4).
7. **Type.** `T` must be assignable to the declared type of the parameter. The check is
   conservative: it compares the type shapes (`TypeHelpers.shape`) like the schema-first conformance
   of RFC 0007 §5.4, and skips `any`, `unknown`, opaque types and parameters without annotation. Its
   most useful case is nullability:

```txt
error ZNIGHT005: @OptionalUser() injects User | undefined, which parameter 'user' of WishlistController.list() does not accept (User)
  --> src/wishlists/wishlist.controller.ts:21:30
  hint: declare the parameter as optional (user?: User), or make the decorator inject User
  related: @OptionalUser is defined in src/auth/current-user.ts:18:14
```

The declared type is the parameter's own: `user?: User` and `user: User = guest` accept
`undefined` (the default value applies when the resolver returns `undefined`, as with any
JavaScript argument).

### 4.6 Resolvers with dependencies

A resolver that needs providers is a class implementing `ParamResolver`:

```ts
@Injectable({ scope: 'request' })
export class CurrentUserResolver implements ParamResolver<HttpContext | ResolverContext, User> {
  #user: Promise<User> | undefined

  constructor(private readonly users: UserRepository) {}

  resolve(ctx: HttpContext | ResolverContext): Promise<User> {
    const state = 'operation' in ctx ? ctx.operation.state : ctx.state
    const id = state.get('userId') as string | undefined
    if (id === undefined) throw new UnauthorizedException()
    // memoized: several @CurrentUser() parameters of one request load the user once
    this.#user ??= this.users.findById(id).then(user => user ?? Promise.reject(new UnauthorizedException()))
    return this.#user
  }
}

export const CurrentUser = createParamDecorator<User>({ http: CurrentUserResolver, graphql: CurrentUserResolver })
```

- The class is bound at build time with `resolveClassRef` (specification §6.5), like guards: a class
  that no decorator registers is registered as a singleton with constructor injection. Its own
  dependencies are bound and validated like any provider (ZNIGHT001, ZNIGHT003, ZNIGHT019).
- The edge from the handler's class (controller, resolver, consumer) to the resolver class is
  **lazy**: the plugin resolves the resolver at call time in the current scope, like guards and
  `@Loader()`. A singleton controller may use a request-scoped resolver; ZNIGHT003 does not apply.
- Singletons are resolved once at boot, request-scoped resolvers once per request (the request scope
  of HTTP, the operation scope of GraphQL, the delivery scope of messaging), transient ones per call.
- The handler definitions of the metadata list the resolver tokens (`paramResolvers`, §5), and the
  plugin passes the instances to `invoke` (§4.7). Overriding the class in tests replaces the resolver
  (§4.12).

Function resolvers cover reading the context; class resolvers cover everything that needs the
container. A function resolver that needs a provider occasionally can take the class form, or read
a value a guard computed.

### 4.7 Generated code (normative)

The extension of each transport generates the call of the resolver in the `invoke` of the handler,
in parameter order, among the other arguments:

| Resolver                    | Expression                                                                  |
| --------------------------- | --------------------------------------------------------------------------- |
| Function (any form)         | `CurrentUser.resolvers.http(ctx, <data>)`                                   |
| Class `CurrentUserResolver` | `x[0].resolve(ctx, <data>)` (`x`: the resolved instances, typed as a tuple) |

`<data>` is a literal (`'sub'`, `undefined`) or an imported reference. The decorator `const` is
imported by the generated module like a schema (`importValue`); inline arrow resolvers need no export
of their own since they are reached through the `const`.

**Asynchronous resolvers** reuse the mechanism of Standard Schema validation in the `invoke` of
`@znight/http` (README, "invoke generation"): the arguments up to the last custom one are evaluated in
order into `a<index>` constants, each custom argument is followed by
`if (isThenable(aN)) return (async () => ...)()`, and the `async` arrow awaits it, then evaluates the
remaining arguments (awaiting their validations and resolvers) and calls the handler. A resolver that
returns a value costs no promise; one that returns a promise makes that request asynchronous, with
the order of evaluation and the first error of an `async` invoke awaiting everything.

```ts
invoke: (c: WishlistController, ctx: HttpContext, x: readonly [CurrentUserResolver]) => {
  const a0 = x[0].resolve(ctx, undefined)
  if (isThenable(a0)) return (async () => c.update(await a0, await validate(UpdateWishlist, ctx.body, 'body')))()
  const a1 = validate(UpdateWishlist, ctx.body, 'body')
  if (isThenable(a1)) return (async () => c.update(a0, await a1))()
  return c.update(a0, a1)
},
```

When the compiler can see that a resolver is asynchronous (an `async` function or method, or a
`Promise<...>` return annotation), it may emit the `async` form directly ("Impl."). The thenable
check is kept for every other resolver: TypeScript accepts a function returning `Promise<T>` where
`T | PromiseLike<T>` is expected, so the compiler cannot prove a resolver synchronous, and handing a
promise to a handler that declared `User` would be a silent bug. An explicit `async: true` option was
considered and rejected (§9.4).

Per transport:

- **HTTP**: `invoke(c, ctx)` becomes `invoke(c, ctx, x)` when the route has class resolvers; `x` is
  declared only then (`noUnusedParameters`).
- **GraphQL**: `invoke(r, p, a, c, i)` gains `f` (the `ResolverContext`) when the field has custom
  parameters, and `x` when it has class resolvers; unused middle parameters keep the `_` prefix.
- **Messaging**: `invoke(c, m)` gains `x` when the handler has class resolvers. Messaging invokes are
  `async` when they validate a payload; custom parameters use the thenable check like HTTP, and an
  `async` invoke simply awaits them.

The `as never` casts used for raw values are not needed: the resolver returns `T | PromiseLike<T>`
with `T` from the definition, `isThenable` (a type guard) narrows it to `T` on the synchronous path,
`await` unwraps it on the other, and the build-time check (§4.5) guarantees that the parameter
accepts `T`. When that check was skipped (an opaque type), the argument is cast with `as never` like
a coerced value.

### 4.8 Pipeline order

Custom parameters are computed inside `invoke`, so they run where the other arguments run:

- **HTTP**: global, controller and route guards → body parsing → interceptors (outermost first) →
  `invoke` (arguments in parameter order: coercions, validations, custom resolvers) → handler. A
  resolver sees what guards stored in `ctx.state` and the effective route metadata; an interceptor
  sees the errors of resolvers and measures their time. It is the order of NestJS (guards →
  interceptors → pipes and parameter factories → handler).
- **GraphQL**: guards → null handling of arguments → `invoke`, all inside the result-mapper wrapper
  of RFC 0008 when the field has one.
- **Messaging**: the `messaging:message` hook → `invoke`.

A route with a custom parameter and no `@Body()` parameter does not get its body parsed before the
interceptors: a resolver that needs the body awaits `ctx.parseBody()`.

### 4.9 Errors

A resolver that throws, or returns a rejected promise, fails the handler exactly as if the handler
had thrown: HTTP exception mappers and `HttpException`s (an `UnauthorizedException` becomes a 401),
GraphQL `errors[]` or a result mapper value (RFC 0008: errors thrown before the resolver are already
in its scope), messaging retries and dead letters. Errors are not wrapped.

### 4.10 Validation

There are no pipes. A resolver validates what it returns when it needs to, with the helpers each
package already exports (`validate(schema, value, label)` of `@znight/http`, which throws the same `ValidationException`
(400) as `@Body(S)`), and a schema can be the data argument:

```ts
export const Header = createParamDecorator<unknown, { name: string; schema: StandardSchemaV1 }>({
  http: (ctx, { name, schema }) => validate(schema, ctx.header(name), `header "${name}"`),
})

export const TenantHeader = { name: 'x-tenant', schema: TenantId } as const
// @Header(TenantHeader) tenant: TenantId
```

Custom parameters are independent of `@Body(S)`, `@Query(name, S)` and `@Validate(S)`: each
parameter has one decorator, and arguments are evaluated in parameter order, so the first failing
argument (validation or resolver) decides the error. ZNIGHT017 (unvalidated input) does not apply:
the compiler does not know what a resolver reads.

### 4.11 OpenAPI and route listings

Custom parameters are not request parameters: `@znight/openapi` leaves them out of `parameters` and
`requestBody`. A decorator that reads a header or a cookie documents it with the existing decorators
(`@ApiHeader`, `@ApiSecurity`), on the controller or the route (Q6). In the HTTP metadata, a custom
parameter is `{ index, source: 'custom', name: 'CurrentUser' }`, so `HttpPlugin.routes` and the hooks
can show it.

### 4.12 Testing

- **`TestBed`** instantiates the class and calls methods directly: decorators are no-ops, the test
  passes the value (`controller.list(user, 1)`).
- **`TestApp`** runs the whole pipeline, resolvers included. Function resolvers read what the
  application's guards stored, so tests authenticate as usual; class resolvers can be replaced like
  any provider
  (`overrides: [override(CurrentUserResolver, createMock(CurrentUserResolver, { resolve: async () => alice }))]`).
- **The resolvers themselves** are plain functions: `CurrentUser.resolvers.http(ctx, undefined)` can
  be called from a test with the context of a `TestApp` request or a stub.

### 4.13 Performance

- Handlers without custom parameters: unchanged generated code (the golden test stays green), no new
  branch in the pipelines.
- Function resolvers: one property read on a frozen object and one call, no closure per request, no
  promise when the resolver returns a value.
- Class resolvers: the plugin resolves them like guards (a singleton is a cached instance, a
  request-scoped one a scope lookup) and passes a preallocated array for singletons ("Impl.").
- GraphQL: one `ResolverContext` per field call, only for fields with custom parameters, shared with
  guards and result mappers.

The HTTP benchmark of `docs/benchmarks.md` gains a route with `@CurrentUser()` (function resolver)
to keep the cost visible.

### 4.14 Bundles

Uses of custom decorators are not stripped by the Vite plugin and the Bun preload in the first
version: like route decorators, they call a no-op function at class definition time. The decorator
`const` stays in the bundle anyway, since the generated module imports it. Stripping uses is a
possible follow-up (Q7).

## 5. Metadata

| Transport | Change                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP      | `HttpParamSource` gains `'custom'` (`name`: the display name of the decorator). `HttpRouteDefinition.paramResolvers?: Token[]`, omitted when empty; `invoke` gains `x`. |
| GraphQL   | `GraphQLResolverBinding.context?: true` (the pipeline builds the `ResolverContext`), `paramResolvers?: Token[]`; `invoke` gains `f` and `x`.                            |
| Messaging | `MessageHandlerDefinition.paramResolvers?: Token[]`; `invoke` gains `x`.                                                                                                |

`paramResolvers` lists the tokens in order of first use; `x[i]` is the instance of
`paramResolvers[i]`. Plugins resolve them in the scope of the call. Optional fields are omitted when
absent, so applications without custom decorators keep byte-identical metadata.

## 6. Compiler

### 6.1 Recognition

The compiler (not each extension) reads definitions: `definitionsOf('@znight/core#createParamDecorator')`
gives the `const`s, their type argument and their first argument. A use is a parameter decorator
whose identity is one of them. Uses keep `owner: undefined` in `DecoratorInfo` (no extension owns a
user identity), as route decorators do today.

### 6.2 Extension API

Two additions to the compiler extension API (specification §6.5):

```ts
interface AnalyzeContext {
  /**
   * The custom parameter decorator of a parameter, read for `transport` (`'http'`): `undefined` when
   * the parameter has none. Marks the use as claimed; problems (§4.5) are reported here, and the
   * result is `{ ok: false }` when the parameter cannot be generated.
   */
  paramDecorator(param: ParameterInfo, transport: string, from: ClassInfo): ParamDecoratorUse | undefined
}

type ParamDecoratorUse =
  | { readonly ok: false }
  | {
      readonly ok: true
      /** Identity and display name of the decorator `const`. */
      readonly identity: string
      readonly name: string
      /** `T`, resolved. */
      readonly valueType: TypeInfo
      /** The data argument (`undefined` without argument). */
      readonly data: ArgInfo | undefined
      readonly resolver:
        | { readonly kind: 'function'; readonly async: boolean }
        | { readonly kind: 'class'; readonly ref: ClassRef; readonly async: boolean }
      /** The value type had to be skipped (opaque): cast the expression with `as never`. */
      readonly cast: boolean
      readonly location: Location
    }

interface TypeHelpers {
  /** Conservative assignability: `true`, `false`, or `undefined` when it cannot be decided. */
  assignable(source: TypeInfo, target: TypeInfo): boolean | undefined
}
```

`paramDecorator` binds the class resolver (`resolveClassRef` with `from` and `lazy: true`) and checks
the value type. At the end of the analysis, the compiler reports every use no extension claimed
(§4.5, rule 3). `assignable` moves the shape comparison of the schema-first conformance into the
compiler, where GraphQL can reuse it.

Each extension then:

1. stops reporting "has no HTTP decorator" (or GraphQL, messaging) for a parameter with a custom
   decorator, and reports "several decorators" when it carries both;
2. stores the use in its handler data and emits it in `invoke` (§4.7) and in the metadata (§5);
3. lets other extensions skip it (`@znight/openapi` reads `source: 'custom'`).

## 7. Specification impact

| Section of `docs/internals/architecture.md` | Change                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| §4.6 Decorators and static evaluation       | Custom parameter decorators: definitions, uses, data as a `value` argument                               |
| §4.8 Validations                            | ZNIGHT005 rows: definition shape, target, transport, data, value type, unclaimed use                     |
| §5 Decorator catalogue                      | `@znight/core`: `createParamDecorator<T, D>(resolvers)`; per transport: custom parameters on handlers    |
| §6.5 Compiler extensions                    | `AnalyzeContext.paramDecorator`, `TypeHelpers.assignable`                                                |
| §8 Core runtime                             | `createParamDecorator`, `ParamDecorator`, `ParamResolver`, `ParamContexts`                               |
| §9.1 HTTP                                   | `source: 'custom'`, `paramResolvers`, `invoke(c, ctx, x)`, pipeline order                                |
| §9.2 Messaging                              | `paramResolvers`, `invoke(c, m, x)`                                                                      |
| §9.5 OpenAPI                                | Custom parameters are not documented                                                                     |
| §9.7 GraphQL                                | `context`, `paramResolvers`, `invoke(r, p, a, c, i, f, x)`; schema-first conformance skips custom params |
| §10 Testing                                 | Overriding class resolvers in `TestApp`                                                                  |

The "Compiler contract" sections of the READMEs of `@znight/http`, `@znight/graphql` and
`@znight/messaging` document the new `invoke` parameters and metadata fields.

## 8. Error codes

No new code. Every usage mistake is ZNIGHT005, the code of an invalid decorator usage whatever the
package (a decorator on the wrong target is always ZNIGHT005), with a message naming the decorator,
the parameter and the handler, and the definition as related location. Problems of resolver classes
use the existing codes of the graph (ZNIGHT001 for a missing dependency, ZNIGHT003 inside the
resolver's own dependencies, ZNIGHT019 for cycles).

## 9. Alternatives considered

### 9.1 Request-scoped providers only (today)

```ts
@Injectable({ scope: 'request' })
export class CurrentUser {
  readonly value: User
  constructor(ctx: HttpContext) {
    this.value = userOf(ctx.state)
  }
}
```

It works today and stays the right tool for services deep in the call chain. For handler inputs it
falls short: the controller becomes request-scoped or takes a `Lazy<CurrentUser>` and calls `.get()`
in every handler, the dependency is invisible in the handler signature, there is no data argument
(`@Claim('sub')`), GraphQL and messaging need their own providers, and nothing checks per handler
that an optional user is handled. A NestJS application with `@CurrentUser()` on 80 handlers
migrates to it with a change per handler; with this RFC, with an import change.

### 9.2 Runtime decorators (NestJS style)

The decorator would record its factory on the method (a symbol property or a `WeakMap`), and
plugins would look it up per handler at boot and call it per request. It needs no compiler work, but
it breaks principles 1 and 2 (decorators would have runtime effects, the pipeline would discover
handler needs at runtime), leaves the value type unchecked, does not survive decorator stripping,
and costs a lookup and a generic argument loop per request where generated code calls the resolver
directly.

### 9.3 One factory per package

`@znight/http#createParamDecorator`, `@znight/graphql#createParamDecorator`... Each extension would
recognise its own definitions, like `createRouteDecorator` today. It is simpler to implement, but it
recreates the `@CurrentUser()` / `@GqlCurrentUser()` pair of NestJS applications, and each package
would duplicate the analysis (definition shape, data, type check). The core factory with per-transport
resolvers keeps one decorator per concept and one analysis in the compiler.

### 9.4 An explicit `async` option

`createParamDecorator<User>({ http: ... }, { async: true })` would let the compiler generate a plain
or an `async` invoke without a runtime check. A wrong flag (a forgotten `async: true`) would hand a
promise to the handler; the thenable check costs one call per custom argument and cannot be wrong.

### 9.5 A transport-neutral context (`ExecutionContext`)

One resolver receiving a wrapper with `switchToHttp()` / `switchToGraphql()`. The wrapper is an
allocation per call, its accessors are untyped until switched, and the compiler cannot tell which
transports a decorator supports. Typed contexts per transport give the same reach without these
costs.

### 9.6 Pipes

Nest pipes transform and validate the value of any parameter. Znight validates with Standard
Schemas at the decorator (`@Body(S)`); adding pipes for custom decorators only would create a second
validation model. A resolver calls `validate()` itself (§4.10).

## 10. Open questions (with recommended answers)

1. **Infer `T` when the type argument is missing?** The compiler has no type checker; it could read
   the return annotation of every resolver and require them to agree. Recommended: **no**, the type
   argument is required (ZNIGHT005 with a fix-it). It is one place to read, and TypeScript checks
   the resolvers against it.
2. **Should resolvers receive the parameter description** (name, declared type, index), like
   Spring's `MethodParameter`? Recommended: **not in the first version**; the data argument is
   explicit and static. It can be added later as a third argument without breaking resolvers.
3. **A `required` option** (routing-controllers), turning `undefined` into an error? Recommended:
   **no**; `T` says whether `undefined` is possible, and a resolver throws the error it wants (401,
   400). The type check of §4.5 enforces the handler side.
4. **Definitions from compiled provider libraries.** Recommended: **sources only in the first
   version**, like route decorators (a source library publishes `"znight": { "library": "source" }`).
   A follow-up can record definitions in `znight.providers.json` (resolver keys, `T` serialised,
   class tokens).
5. **Caching values per request** (FastAPI caches dependencies)? Recommended: **no**; a function
   resolver is cheap, a request-scoped class resolver memoizes what it needs (§4.6).
6. **Let a decorator describe what it reads for OpenAPI** (a header, a security scheme)?
   Recommended: **no in the first version**; `@ApiHeader` and `@ApiSecurity` document it. A
   `createParamDecorator(..., { openapi })` option can come with a real use case.
7. **Strip uses from bundles.** Recommended: **follow-up**, together with route decorators: the
   catalog would learn user identities from `definitionsOf`, and the strip ranges would include them.
8. **Method injection** (`@Inject() users: UserService` on a handler parameter) built on class
   resolvers? Recommended: **separate RFC if asked for**; constructor injection covers it today.
9. **WebSocket gateways.** Recommended: RFC 0003 adds a `websocket` key when it is implemented; this
   RFC reserves nothing else.

## 11. Migration from NestJS

| NestJS                                                                        | Znight                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `createParamDecorator((data, ctx) => ctx.switchToHttp().getRequest().user)`   | `createParamDecorator<User>({ http: ctx => ctx.state.get('user') as User })`                     |
| `GqlExecutionContext.create(ctx).getContext().req.user` in a second decorator | a `graphql` resolver in the same definition: `graphql: ctx => ctx.operation.state.get('user')`   |
| `@CurrentUser()` and `@GqlCurrentUser()`                                      | one `@CurrentUser()`                                                                             |
| `request.user` set by a Passport guard                                        | `ctx.state.set('user', user)` in the guard (Security guide)                                      |
| `data` argument, any runtime value                                            | `data` argument, static or an exported `const` (§4.4)                                            |
| `createParamDecorator<string>` (types `data` only)                            | `createParamDecorator<User, string>`: `T` checked against each parameter at build time           |
| `@CurrentUser(new ValidationPipe({ validateCustomDecorators: true }))`        | `validate(S, value, label)` in the resolver, or the schema as data (§4.10)                       |
| `Reflector` reading handler metadata in the factory                           | route decorators: `Roles.get(ctx)` (`HttpContext` and `ResolverContext` are `RouteMetaCarrier`s) |
| A pipe class to reach providers                                               | a class resolver with constructor injection (§4.6)                                               |
| `applyDecorators(...)`                                                        | not supported: apply the decorators directly                                                     |

`znight` codemods are not part of this RFC; the change in an application is the definition file and
the imports of the decorator.

## 12. Implementation plan

1. **Core**: `createParamDecorator`, `ParamDecorator`, `ParamResolver`, `ParamContexts`; type tests
   (data argument arity, keys of installed transports).
2. **Compiler**: definition reading, `AnalyzeContext.paramDecorator`, `TypeHelpers.assignable`
   (moved from the GraphQL conformance), unclaimed uses; specification §4.6, §4.8, §6.5.
3. **HTTP**: analysis, `invoke` generation (reusing the thenable block of validation),
   `paramResolvers` in the pipeline and `TestApp`, `source: 'custom'`, OpenAPI skips it; tests on the
   four adapters, Node.js and Bun; the golden test stays byte-identical for the examples.
4. **GraphQL**: `ResolverContext` for custom parameters, `invoke` generation, code-first and
   schema-first (conformance skips custom parameters).
5. **Messaging**: analysis, `invoke` generation, `paramResolvers`.
6. **Docs and examples**: a "Custom parameter decorators" section in the guides (dependency
   injection or a page of its own), the Security guide and the `secure-api` example use
   `@CurrentUser()`, the NestJS migration guide gets the table of §11, the roadmap moves the item,
   the benchmark route of §4.13. A changeset per published package (`minor`).

## 13. Testing plan

- Compiler: every ZNIGHT005 of §4.5 with its location and related location; `assignable` on the
  shapes of the conformance suite; definitions through barrels, renamed imports and namespace
  imports; a definition used by several transports; unclaimed uses.
- Generated code: synchronous and asynchronous function and class resolvers, mixed with validated
  arguments (order of evaluation, first error), strict-clean (`codegen/typecheck.test.ts`),
  deterministic (golden).
- Runtime: scopes of class resolvers (singleton, request, transient), errors through exception
  mappers, GraphQL `errors[]` and result mappers, messaging retries; `TestApp` overrides.

## 14. Implementation notes

What the implementation settled where this document was not precise, or differs from it (the
specification, `docs/internals/architecture.md` §4.6, §6.5, §8.6, §9.1, §9.2, §9.7, is normative):

- **No `R` type parameter.** TypeScript does not infer a type parameter when another one is given
  explicitly (`createParamDecorator<User>({...})`), so `ParamDecorator<T, D>` keeps
  `resolvers: ParamResolvers<T, D>`. Generated code selects the function member with a type-only
  cast, `(CurrentUser.resolvers.http as ParamFunctionOf<typeof CurrentUser, 'http'>)(ctx, data)`,
  which costs nothing at runtime.
- **`TypeHelpers.assignable(source, target)`** accepts a `TypeInfo` or a shape target such as
  `{ parameter }` (aliases and object literal types are kept). Nothing was moved from the GraphQL
  conformance, which compares TypeScript shapes with SDL types: the comparison of two TypeScript
  types is new (`packages/compiler/src/shapes/assignable.ts`, `members: 'instance'`, recursive types
  compared coinductively).
- **Class resolvers and the data argument.** When the class's own `resolve` declares fewer than two
  parameters, the generated call leaves the data out (`x[0].resolve(ctx)`): TypeScript checks the
  arity of the call against the class.
- **Messaging** awaits custom parameters (the invoke becomes `async` for such handlers) instead of
  the `isThenable` fallback: a delivery already awaits `invoke`, and handlers without custom
  parameters are unchanged. Parameter resolvers are resolved in the delivery scope on every call.
- **GraphQL** `GraphQLResolverBinding.invoke` is declared as a method (bivariant parameters), so that
  a generated invoke requiring `f` is accepted while hand-written bindings keep five parameters.
- **`TestApp`** treats the parameter resolvers of routes, fields and message handlers as roots.
- **Benchmarks.** The route with `@CurrentUser()` in the HTTP benchmark (§4.13) is not added yet.

