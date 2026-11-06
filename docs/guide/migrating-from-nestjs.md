---
description: Move a NestJS application to Znight - decorator mapping, modules to flat DI, forRootAsync to options computed from the container, ValidationPipe to schemas, Reflector to route decisions, Swagger and schedule.
---

# Migrating from NestJS

Znight deliberately looks familiar if you know NestJS: classes, decorators, constructor injection,
guards, interceptors, lifecycle hooks. The differences come from one design decision: the dependency
graph is resolved by a **compiler**, not at runtime. This page maps NestJS concepts to Znight and
walks through a migration.

## What changes, in short

| NestJS                                                   | Znight                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `reflect-metadata`, `emitDecoratorMetadata`              | Removed: the compiler reads types from the source                       |
| Modules (`imports`, `providers`, `exports`)              | Removed: one flat container, providers discovered by scanning           |
| String/symbol tokens for interfaces                      | Inject the interface type directly                                      |
| `forwardRef()`                                           | `Lazy<T>`                                                               |
| `forRoot()` / `forRootAsync({ useFactory, inject })`     | `XxxPlugin.configure(options)` / `configure(container => options)`      |
| `ValidationPipe` + `class-validator` DTOs                | Schemas (Zod, Valibot...) passed to `@Body()` / `@Query()` / `@Param()` |
| `@SetMetadata()` + `Reflector`                           | `createRouteDecorator()` + `route.meta`, decisions checked at build     |
| Errors at boot (`Nest can't resolve dependencies of...`) | Errors at build time (`ZNIGHT001`...)                                   |

## Decorator mapping

### Dependency injection

| NestJS                                      | Znight                                                                               | Notes                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `@Injectable()`                             | `@Injectable()`                                                                      | From `@znight/core`. Options: `scope`, `name`, `primary`.            |
| `@Injectable({ scope: Scope.REQUEST })`     | `@Injectable({ scope: 'request' })`                                                  | Plain strings: `'singleton'`, `'request'`, `'transient'`.            |
| `@Inject(TOKEN)` with a string/symbol token | Inject by type; `@Inject('name')` + `@Named('name')` to choose among implementations | Qualifiers are names, not values.                                    |
| `@Optional()`                               | `@Optional()`, `param?: T`, `T \| undefined` or a default                            | All equivalent.                                                      |
| `forwardRef(() => X)`                       | `Lazy<X>`                                                                            | `this.x.get()` resolves it at call time.                             |
| `{ provide: X, useClass: Y }`               | `class Y implements X` (+ `@Primary()` if several)                                   | The compiler finds implementations through `implements` / `extends`. |
| `{ provide: X, useFactory, inject }`        | `@Factory()` class with a `@Provides()` method                                       | Method parameters are injected; `Promise<T>` return type for async.  |
| `{ provide: X, useValue }`                  | `Application.create({ providers: [[X, value]] })`                                    | Or a `@Provides()` method returning the value.                       |
| `{ provide: X, useExisting: Y }`            | `class Y implements X`, or a `@Provides()` method `(y: Y): X => y`                   |                                                                      |
| `@Global()`                                 | Not needed                                                                           | Everything is global.                                                |
| `ModuleRef.get(X)`                          | `container.get(X)`                                                                   | Inject `Container` from `@znight/core`.                              |

### HTTP

| NestJS                                             | Znight (`@znight/http`)                                       | Notes                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `@Controller('users')`                             | `@Controller('/users')`                                       | Also `{ path, scope }`.                                                                     |
| `@Get() @Post() @Put() @Patch() @Delete()`         | Same                                                          | Plus `@Head()`, `@Options()`, `@All()`.                                                     |
| `@Param('id', ParseIntPipe) id: number`            | `@Param('id') id: number`                                     | Coerced from the declared type; invalid → `400`.                                            |
| `@Query()`, `@Body()`, `@Headers()`                | `@Query(name?, schema?)`, `@Body(schema?)`, `@Headers(name?)` | Schemas validate and transform.                                                             |
| `@Req()`, `@Res()`                                 | `@Req()`, `@Res()`                                            | Adapter-specific escape hatches (warning). Prefer `@Ctx()` (`HttpContext`).                 |
| `@HttpCode(204)`, `@Header('x', 'y')`              | Same                                                          |                                                                                             |
| `@UseGuards(AuthGuard)`                            | `@UseGuard(AuthGuard)`                                        | Guards are providers implementing `CanActivate`, injected like any other.                   |
| `@UseInterceptors(X)`                              | `@UseInterceptor(X)`                                          | Route-level. For any provider method: `@Intercept()` ([AOP](./aop)).                        |
| `@UsePipes(ValidationPipe)`                        | Schemas on parameters, or `@Validate(schema)`                 | See [validation](#validationpipe-schemas).                                                  |
| `@UseFilters()` / `ExceptionFilter`                | `exceptionMappers` option of `HttpPlugin`                     | `HttpException(status, message, details?)` for expected errors.                             |
| `@SetMetadata('roles', [...])` + `Reflector`       | `createRouteDecorator<T>('roles')`                            | See [route metadata](#reflector-createroutedecorator).                                      |
| `createParamDecorator((data, ctx) => ...)`         | `createParamDecorator<T, D>({ http, graphql, messaging })`    | One resolver per transport, checked at build time. See [below](#createparamdecorator).      |
| `@UploadedFile()` + `FileInterceptor('file')`      | `@UploadedFile('file', { maxSize, mimeTypes })`               | No interceptor nor Multer: standard `File` objects, limits checked while reading.           |
| `cookie-parser` + `@Req() req.cookies`             | `@Cookie('name')`, `@SignedCookie('name')`, `ctx.cookies`     | Coerced like headers; signed cookies with key rotation ([cookies](/packages/http#cookies)). |
| `res.cookie()`                                     | `ctx.setCookie()` / `HttpResponse.withCookie()`               | Secure defaults: `Secure; HttpOnly; SameSite=Lax`.                                          |
| `@Sse()` returning `Observable<MessageEvent>`      | `@Sse()` returning an `AsyncIterable<SseEvent>`               | No RxJS; `EventChannel` instead of a `Subject`.                                             |
| `app.enableCors()`, `helmet()`                     | `cors` and `securityHeaders` options of `HttpPlugin`          | Handled by the plugin on every adapter ([Security](./security)).                            |
| `@nestjs/swagger` (`@ApiProperty`, `@ApiResponse`) | [`@znight/openapi`](/packages/openapi)                        | Schemas from TypeScript types and JSDoc, checked at build time; no `@ApiProperty`.          |

### Messaging, config, lifecycle, data

| NestJS                                               | Znight                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `@MessagePattern()` / `@EventPattern()`              | `@Consumer('queue')` class + `@OnMessage(type?)` methods                                                                                 |
| `@Payload()`, `@Ctx()`                               | `@Message(schema?)`, `@Ctx()`                                                                                                            |
| `ConfigModule.forRoot()` + `ConfigService.get('X')`  | `@Config()` classes with `@Env('X')` properties                                                                                          |
| `OnModuleInit`                                       | `OnStart` (`onStart()`)                                                                                                                  |
| `OnApplicationBootstrap`                             | `OnReady` (`onReady()`)                                                                                                                  |
| `OnModuleDestroy`, `BeforeApplicationShutdown`       | `OnStop` (`onStop()`)                                                                                                                    |
| `OnApplicationShutdown`                              | `[Symbol.asyncDispose]()` or `@Provides({ dispose })`                                                                                    |
| `app.enableShutdownHooks()`                          | On by default (`SIGINT`, `SIGTERM`)                                                                                                      |
| `NestFactory.create(AppModule)` + `app.listen(3000)` | `Application.create({ metadata, plugins: [HttpPlugin.configure({ port: 3000 })] })` + `app.start()`                                      |
| `Test.createTestingModule({...}).compile()`          | `TestBed.create(Class, { metadata })` / `TestApp.create()`                                                                               |
| `.overrideProvider(X).useValue(fake)`                | `overrides: [[X, fake]]`                                                                                                                 |
| `new Logger(X.name)` (`@nestjs/common`)              | An injected `Logger`, or `getLogger(X.name)` outside DI ([below](#logger-to-getlogger))                                                  |
| `Logger.overrideLogger(false)` in specs              | `setFallbackLogger(new Logger({ level: 'silent' }))` once, in the test preload ([below](#logger-to-getlogger))                           |
| `ScheduleModule.forRoot()`, `@Cron()`, `@Interval()` | [`@znight/schedule`](/packages/schedule): `SchedulePlugin`, `@Cron()`, `@Interval('10s')`                                                |
| `@nestjs/cqrs` `EventBus`, `@EventsHandler(X)`       | [`@znight/events`](/packages/events): `EventPublisher.publish()`, `@OnEvent({ detached: true })` ([below](#application-events))          |
| `@nestjs/event-emitter` `@OnEvent('x.y')`            | `@OnEvent()` on a method typed with the event class; wildcards become base classes ([below](#application-events))                        |
| `TypeOrmModule`, `@InjectRepository(User)`           | A `@Factory()` providing the client, repositories behind interfaces ([Data access](./data-access))                                       |
| `CacheModule`, `CacheInterceptor`                    | A method interceptor ([cache recipe](./aop#cache)); `@znight/cache` is planned                                                           |
| `@WebSocketGateway()`                                | `@Gateway(path)` of [`@znight/websocket`](/packages/websocket) ([WebSockets guide](/guide/websockets))                                   |
| `@nestjs/graphql` (code first)                       | [`@znight/graphql`](/packages/graphql): the TypeScript types are the schema ([guide](/guide/graphql#nestjs))                             |
| `@nestjs/graphql` (schema first, `typePaths`)        | [`@znight/graphql`](/packages/graphql) schema-first: the same `.graphql` files, resolvers bound by name ([below](#graphql-schema-first)) |
| A Yoga/Envelop plugin turning exceptions into data   | `resultMappers` of `GraphQLPlugin`, per field ([errors as data](/guide/graphql#errors-as-data))                                          |
| `driver: YogaDriver`, `ApolloDriver`                 | `GraphQLPlugin.configure({ driver: yogaDriver() })`; the built-in transport otherwise ([below](#graphql-drivers))                        |
| `express-session`, `@Session()`                      | Not included: signed cookies, and cookie sessions in the [Security guide](./security#csrf)                                               |

## Modules → flat DI {#modules-to-flat-di}

NestJS modules group providers and control their visibility:

```ts
// NestJS
@Module({
  imports: [DatabaseModule, ConfigModule.forRoot()],
  controllers: [UserController],
  providers: [UserService, { provide: 'USER_REPOSITORY', useClass: PgUserRepository }],
  exports: [UserService],
})
export class UserModule {}
```

In Znight, delete the module. Every exported `@Injectable()` class under `src/` is a provider, and
interfaces are injected by type:

```ts
// Znight
@Injectable()
export class PgUserRepository implements UserRepository {}

@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {} // no @Inject('USER_REPOSITORY')
}
```

What modules gave you, and how to get it back:

- **Encapsulation**: use the language. Do not export what other features must not use, or keep
  internal code in a separate package exposing a narrow public entry.
- **Feature folders**: keep them; they simply do not need a module file.
- **Dynamic modules** (`forRoot`): become plugins with options, see below.
- **Shared libraries**: become [provider libraries](./compiler#provider-libraries).

## `forRootAsync` → options as a function of the container {#forrootasync-to-plugin-options}

```ts
// NestJS
TypeOrmModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({ url: config.get('DATABASE_URL') }),
})
```

Znight plugins accept their options either directly or as a function of the **initialised**
container, evaluated before the application starts:

```ts
// Znight
const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [ConfigPlugin.configure(), HttpPlugin.configure(container => ({ port: container.get(ServerConfig).port }))],
})
```

No `imports`, no `inject` array: call `container.get()` with whatever you need. For providers of your
own (a database client, an SDK), use a `@Factory()` ([Data access](./data-access) has the complete
pattern, with Drizzle):

```ts
@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'end' })
  async createPool(config: DatabaseConfig): Promise<Pool> {
    return new Pool({ connectionString: config.url })
  }
}
```

## `ValidationPipe` → schemas {#validationpipe-schemas}

NestJS validates DTO classes with `class-validator` decorators through a global pipe:

```ts
// NestJS
export class CreateUserDto {
  @IsEmail() email: string
  @IsString() @MinLength(2) name: string
}

@Post()
create(@Body() dto: CreateUserDto) {}
```

Znight validates with **schemas** attached to the parameter. The handler receives the schema
**output** (defaults applied, unknown keys stripped, transforms run), and failures become a `400`
with `details: [{ path, message }]`:

```ts
// Znight
import { z } from 'zod'

export const CreateUserSchema = z.object({
  email: z.email(),
  name: z.string().min(2),
})
export type CreateUser = z.infer<typeof CreateUserSchema>

@Post('/')
create(@Body(CreateUserSchema) input: CreateUser) {}
```

`@Validate(CreateUserSchema)` on the method is sugar for `@Body(CreateUserSchema)`. Schemas must be
exported constants so the generated code can import them. A non-primitive `@Body()` without a schema
is reported as [`ZNIGHT017`](/reference/error-codes#znight017) (an error with `strictValidation`).

## `Reflector` → `createRouteDecorator` {#reflector-createroutedecorator}

```ts
// NestJS
export const Roles = (...roles: string[]) => SetMetadata('roles', roles)

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const roles = this.reflector.get<string[]>('roles', context.getHandler())
    // ...
  }
}
```

In Znight, route metadata is collected by the compiler and stored in the generated route definition
(`route.meta`). Declare the decorators with `createRouteDecorator` and read the values from the
context in your guard (`Roles.get(ctx)`): no reflection. Give access decorators a common `group` and
make it `required`: they become alternatives for one **decision** per route (the route's replaces the
controller's), and a route without a decision fails the build
([`ZNIGHT023`](/reference/error-codes#znight023)), something NestJS cannot check.

```ts
// Znight
import { Injectable, type Lazy } from '@znight/core'
import { type CanActivate, Controller, createRouteDecorator, Get, type HttpContext } from '@znight/http'

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly string[]>('roles', { group: 'access', required: true })

@Injectable()
export class AuthGuard implements CanActivate {
  static readonly enforces = [Public, Roles] // checked at boot: every decision has a guard

  constructor(
    private readonly authenticator: Authenticator,
    private readonly user: Lazy<CurrentUser>, // request-scoped, filled here, read by any provider
  ) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    if (Public.get(ctx)) return true
    const principal = await this.authenticator.authenticate(ctx) // throws 401
    this.user.get().authenticate(principal)
    const roles = Roles.get(ctx) // the nearest decision: the route's, else the controller's
    return roles !== undefined && roles.some(role => principal.roles.includes(role))
  }
}

@Controller('/admin')
@Roles(['admin'])
export class AdminController {
  @Get('/stats')
  stats() {}

  @Get('/health')
  @Public() // replaces the controller's decision
  health() {}
}
```

Register the guard globally (`HttpPlugin.configure({ guards: [AuthGuard] })`, the equivalent of
`APP_GUARD`). Instead of `ctx.state.get('user')`, a request-scoped `CurrentUser` keeps the caller
typed and visible in the dependency graph. The [Security guide](./security) has the complete
recipes: JWT and OIDC with `jose`, API keys, policies, rate limiting, CSRF.

## `createParamDecorator` → one resolver per transport {#createparamdecorator}

NestJS parameter decorators receive an `ExecutionContext` and switch on its type; Znight's take
one resolver per transport, each with the typed context of its transport, and the compiler checks
every use ([Custom parameter decorators](./custom-parameters)).

| NestJS                                                                        | Znight                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `createParamDecorator((data, ctx) => ctx.switchToHttp().getRequest().user)`   | `createParamDecorator<User>({ http: ctx => ctx.state.get('user') as User })`                     |
| `GqlExecutionContext.create(ctx).getContext().req.user` in a second decorator | a `graphql` resolver in the same definition: `graphql: ctx => ctx.operation.state.get('user')`   |
| `@CurrentUser()` and `@GqlCurrentUser()`                                      | one `@CurrentUser()`                                                                             |
| `request.user` set by a Passport guard                                        | `ctx.state.set('user', user)` in the guard ([Security](./security))                              |
| `data` argument, any runtime value                                            | `data` argument, static or an exported `const`                                                   |
| `createParamDecorator<string>` (types `data` only)                            | `createParamDecorator<User, string>`: `T` checked against each parameter at build time           |
| `@CurrentUser(new ValidationPipe({ validateCustomDecorators: true }))`        | `validate(S, value, label)` in the resolver, or the schema as data                               |
| `Reflector` reading handler metadata in the factory                           | route decorators: `Roles.get(ctx)` (`HttpContext` and `ResolverContext` are `RouteMetaCarrier`s) |
| A pipe class to reach providers                                               | a class resolver implementing `ParamResolver`, with constructor injection                        |
| `applyDecorators(...)`                                                        | not supported: apply the decorators directly                                                     |

## `new Logger(X.name)` → `getLogger()` {#logger-to-getlogger}

NestJS code often creates its loggers statically, in a field initialiser, and specs silence them
with `Logger.overrideLogger(false)`:

```ts
// NestJS
@Injectable()
export class AddAttendeeUseCase {
  private readonly logger = new Logger(AddAttendeeUseCase.name)
  constructor(private readonly events: EventRepository) {}
}
```

In Znight the `Logger` of [`@znight/observability`](/packages/observability#logging) is injected
like any provider, and it is the recommended form: it is visible in the dependency graph and a
`TestBed` hands a mock. Injecting it adds a constructor parameter, though, which breaks every spec
calling `new AddAttendeeUseCase(...)` with positional arguments. `getLogger()` keeps the static form
while you migrate, or for classes the container does not create:

```ts
// Znight
import { Injectable } from '@znight/core'
import { getLogger } from '@znight/observability'

@Injectable()
export class AddAttendeeUseCase {
  private readonly logger = getLogger(AddAttendeeUseCase.name)
  constructor(private readonly events: EventRepository) {}
}
```

Its entries go through the application logger (level, redaction, transports, `requestId` inside a
request), with a `logger` field holding the name; entries written before the application exists
are buffered and written once it does. In specs that create no application, replace the
`Logger.overrideLogger(false)` calls with one line in the test preload:

```ts
import { Logger, setFallbackLogger } from '@znight/observability'

setFallbackLogger(new Logger({ level: 'silent' }))
```

A `TestApp` still writes the entries to its own logger: configure `ObservabilityPlugin` with
`logging: { level: 'silent' }`, or capture them with `logging: { destination }`.

## Interfaces without tokens

NestJS needs tokens because interfaces disappear at runtime:

```ts
// NestJS
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY')
providers: [{ provide: PAYMENT_GATEWAY, useClass: StripeGateway }]
constructor(@Inject(PAYMENT_GATEWAY) private payments: PaymentGateway) {}
```

The Znight compiler sees the interface in the source and binds it:

```ts
// Znight
@Injectable()
export class StripeGateway implements PaymentGateway {}

constructor(private readonly payments: PaymentGateway) {}
```

With several implementations, mark one `@Primary()` or qualify them with `@Named()` / `@Inject()`
([details](./dependency-injection#several-implementations-primary)).

## GraphQL schema-first applications {#graphql-schema-first}

A NestJS application built with `GraphQLModule.forRoot({ typePaths: ['src/**/*.graphql'] })` keeps
its SDL files: the [schema-first mode](./graphql#schema-first) reads them at build time and binds
the resolvers by name, like NestJS.

```ts [znight.config.ts]
import graphql from '@znight/graphql/compiler'
import type { ZnightOptions } from '@znight/compiler'

export default {
  extensions: [graphql.configure({ schema: 'src/**/*.graphql', sdl: 'schema.graphql' })],
} satisfies ZnightOptions
```

| NestJS schema first                                       | Znight                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `typePaths` of `GraphQLModule`                            | `graphql.configure({ schema })` at build time                              |
| `@Resolver()`, `@Resolver('Event')`                       | the same (`@Resolver('Event', { scope: 'request' })` for a scope)          |
| `@Query()`, `@Mutation('name')`, `@ResolveField('owner')` | the same, from `@znight/graphql`                                           |
| `@Args('id')`, `@Args('input', new ZodPipe(Schema))`      | `@Args('id')`, `@Args('input', Schema)` (any Standard Schema)              |
| `@Parent()`, `@Context()`, `@Info()`                      | `@Parent()`, `@Ctx()` (the request-scoped `GraphQLContext`), `@Info()`     |
| loaders created in the context factory                    | `BatchLoad` providers injected with `@Loader()` (one batch per execution)  |
| custom scalars without implementation                     | `scalar<T>('EventId', { serialize, parseValue })`, `T` the codegen mapping |
| `__typename` set by mappers for unions                    | the same: unions and interfaces resolve from `__typename`                  |
| `@UseGuards()`, global `APP_GUARD`                        | `@UseGuard()`, `GraphQLPlugin.configure({ guards })`, route decorators     |
| unbound fields found at the first request                 | coverage and type conformance at build time (ZNIGHT067, ZNIGHT068)         |

The first build lists, at once, every root field without resolver, every resolver whose signature
does not match the SDL (a `Promise<Event | undefined>` for an `Event!`, an `@Args('limit') limit:
number` for a nullable `Int` that clients may omit) and every field that neither a resolver nor the
returned type provides. Types generated by GraphQL Code Generator (`typescript` plugin, scalars
mapped to the `scalar<T>()` types) pass as they are. Custom directives are ignored with a warning;
`__resolveType` methods are not supported yet: return objects carrying `__typename`.

## GraphQL drivers {#graphql-drivers}

`@nestjs/graphql` builds the schema and hands it to a driver that owns the server and the
execution. Znight keeps the execution (its compiled resolvers, guards, loaders, masking and hook)
and lets a driver own the transport ([RFC 0009](https://github.com/znight-org/znight/blob/main/rfcs/0009-graphql-drivers.md)):
the built-in GraphQL-over-HTTP and SSE endpoint by default, GraphQL Yoga with
[`yogaDriver()`](./graphql#yoga).

| NestJS (`@nestjs/graphql`)                                        | Znight                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GraphQLModule.forRoot<YogaDriverConfig>({ driver: YogaDriver })` | `GraphQLPlugin.configure({ driver: yogaDriver() })` (`@znight/graphql/yoga`)               |
| `driver: ApolloDriver`                                            | The built-in transport; an Apollo Server driver once Apollo Server accepts graphql-js 17   |
| `driver: MercuriusDriver`                                         | The built-in transport on `fastifyAdapter()` (no Mercurius driver is planned)              |
| `ApolloFederationDriver`, `YogaFederationDriver`                  | Not yet: federation is a planned engine feature, for every driver                          |
| `ApolloGatewayDriver`                                             | Not planned: run Apollo Router or Hive Gateway in front of Znight subgraphs                |
| `plugins: [...]` (Envelop plugins of Yoga)                        | `yogaDriver({ plugins: [...] })`                                                           |
| `graphiql: true`, `playground`                                    | `graphiql: true` on `GraphQLPlugin` (the driver's IDE)                                     |
| `context: ({ req }) => ({ user: req.user })`                      | Request-scoped providers; `GraphQLContext.http`; Yoga's context through `yogaContext(ctx)` |
| `formatError`, `maskedErrors`                                     | `errorMappers` and `exposeErrors`: the engine masks once, Yoga's masking is off            |
| `subscriptions: { 'graphql-ws': true }`                           | SSE (Yoga's or the built-in transport's); `graphql-ws` comes with `@znight/websocket`      |
| `transformSchema`, `buildSchemaOptions`                           | Not supported: the engine owns the schema                                                  |
| `path`, `useGlobalPrefix`                                         | `path`; the `HttpPlugin` prefix always applies                                             |
| Mercurius `jit`, `loaders`                                        | No JIT (a Yoga plugin replacing the execution is refused); `@Loader()`                     |

## Application events {#application-events}

`@nestjs/cqrs` events and `@nestjs/event-emitter` map to [`@znight/events`](/guide/events). Events stay
classes; the handler's parameter type replaces the decorator argument.

| NestJS                                                             | Znight                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `CqrsModule.forRoot()`, `EventEmitterModule.forRoot()`             | `EventsPlugin.configure()` in `Application.create({ plugins })`             |
| `@EventsHandler(UserCreated)` + `implements IEventHandler<...>`    | Remove both; `@OnEvent({ detached: true })` on `handle(event: UserCreated)` |
| `@EventsHandler(A, B)` + `handle(event: A \| B)`                   | `@OnEvent({ detached: true }) handle(event: A \| B)`                        |
| `eventBus.publish(e)`                                              | `await events.publish(e)` (inject `EventPublisher`)                         |
| `publishAll([a, b])`                                               | `for (const e of [a, b]) await events.publish(e)`                           |
| `UnhandledExceptionBus`                                            | `EventsPlugin.configure({ onError })` or the `events:listener` hook         |
| `eventEmitter.emit('order.created', payload)`                      | `events.emit(new OrderCreated(...))`                                        |
| `emitAsync('order.created', payload)`                              | `await events.publish(new OrderCreated(...))`                               |
| `@OnEvent('order.created')` + `handle(payload: OrderCreatedEvent)` | `@OnEvent()` + `handle(event: OrderCreated)` (ZNIGHT070 hints it)           |
| `@OnEvent('order.*')`                                              | A base class (`OrderEvent`) as the parameter type                           |
| `{ async: true }`, `suppressErrors`                                | `{ detached: true }`                                                        |
| `prependListener: true`                                            | `{ order: -1 }`                                                             |
| `createMock<EventBus>()` in unit specs                             | `TestBed` auto-mocks `EventPublisher`                                       |

Every cqrs handler maps to a **detached** listener to keep its behaviour (it runs after `publish()`
and its errors do not reach the publisher). Make one inline when its work must succeed for the
operation to succeed.

## Bootstrap

```ts
// NestJS
const app = await NestFactory.create(AppModule)
app.enableShutdownHooks()
await app.listen(3000)
```

```ts
// Znight
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000 })],
})
await app.start()
```

## Migration checklist

1. **Tooling**: add `@znight/compiler` and Vite ([manual setup](./getting-started#manual-setup)),
   remove `reflect-metadata` and `emitDecoratorMetadata`, keep `experimentalDecorators`.
2. **Imports**: replace `@nestjs/common` imports with `@znight/core` / `@znight/http` equivalents
   (table above). `@Injectable()` classes usually need no other change.
3. **Modules**: delete them. Turn `useClass`/`useFactory`/`useValue` providers into `implements`,
   `@Factory()`/`@Provides()` and `providers` values.
4. **Tokens**: replace `@Inject(TOKEN)` on interfaces by the interface type; keep qualifiers only
   where several implementations coexist.
5. **Validation**: convert DTO classes to schemas.
6. **Guards, interceptors, filters**: adapt signatures to `HttpContext`; move filters to
   `exceptionMappers`.
7. **Lifecycle hooks**: rename (`onModuleInit` → `onStart`, ...).
8. **Build** and fix the `ZNIGHT` diagnostics: they point to every wiring problem at once, with hints.
9. **Tests**: `Test.createTestingModule` becomes `TestBed` or `TestApp`; `overrideProvider` becomes
   `overrides`; `Logger.overrideLogger(false)` becomes one `setFallbackLogger()` in the preload.
