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
| `@UploadedFile()` + `FileInterceptor('file')`      | `@UploadedFile('file', { maxSize, mimeTypes })`               | No interceptor nor Multer: standard `File` objects, limits checked while reading.           |
| `cookie-parser` + `@Req() req.cookies`             | `@Cookie('name')`, `@SignedCookie('name')`, `ctx.cookies`     | Coerced like headers; signed cookies with key rotation ([cookies](/packages/http#cookies)). |
| `res.cookie()`                                     | `ctx.setCookie()` / `HttpResponse.withCookie()`               | Secure defaults: `Secure; HttpOnly; SameSite=Lax`.                                          |
| `@Sse()` returning `Observable<MessageEvent>`      | `@Sse()` returning an `AsyncIterable<SseEvent>`               | No RxJS; `EventChannel` instead of a `Subject`.                                             |
| `app.enableCors()`, `helmet()`                     | `cors` and `securityHeaders` options of `HttpPlugin`          | Handled by the plugin on every adapter ([Security](./security)).                            |
| `@nestjs/swagger` (`@ApiProperty`, `@ApiResponse`) | [`@znight/openapi`](/packages/openapi)                        | Schemas from TypeScript types and JSDoc, checked at build time; no `@ApiProperty`.          |

### Messaging, config, lifecycle, data

| NestJS                                               | Znight                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@MessagePattern()` / `@EventPattern()`              | `@Consumer('queue')` class + `@OnMessage(type?)` methods                                            |
| `@Payload()`, `@Ctx()`                               | `@Message(schema?)`, `@Ctx()`                                                                       |
| `ConfigModule.forRoot()` + `ConfigService.get('X')`  | `@Config()` classes with `@Env('X')` properties                                                     |
| `OnModuleInit`                                       | `OnStart` (`onStart()`)                                                                             |
| `OnApplicationBootstrap`                             | `OnReady` (`onReady()`)                                                                             |
| `OnModuleDestroy`, `BeforeApplicationShutdown`       | `OnStop` (`onStop()`)                                                                               |
| `OnApplicationShutdown`                              | `[Symbol.asyncDispose]()` or `@Provides({ dispose })`                                               |
| `app.enableShutdownHooks()`                          | On by default (`SIGINT`, `SIGTERM`)                                                                 |
| `NestFactory.create(AppModule)` + `app.listen(3000)` | `Application.create({ metadata, plugins: [HttpPlugin.configure({ port: 3000 })] })` + `app.start()` |
| `Test.createTestingModule({...}).compile()`          | `TestBed.create(Class, { metadata })` / `TestApp.create()`                                          |
| `.overrideProvider(X).useValue(fake)`                | `overrides: [[X, fake]]`                                                                            |
| `ScheduleModule.forRoot()`, `@Cron()`, `@Interval()` | [`@znight/schedule`](/packages/schedule): `SchedulePlugin`, `@Cron()`, `@Interval('10s')`           |
| `TypeOrmModule`, `@InjectRepository(User)`           | A `@Factory()` providing the client, repositories behind interfaces ([Data access](./data-access))  |
| `CacheModule`, `CacheInterceptor`                    | A method interceptor ([cache recipe](./aop#cache)); `@znight/cache` is planned                      |
| `@WebSocketGateway()`, `@nestjs/graphql`             | Planned for v0.2 ([roadmap](/roadmap#v0-2)); Server-Sent Events today                               |
| `express-session`, `@Session()`                      | Not included: signed cookies, and cookie sessions in the [Security guide](./security#csrf)          |

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
   `overrides`.
