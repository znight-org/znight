# Monorepo example: provider libraries

Two services sharing providers through a package of the monorepo. With Znight there are no modules
to import: a service **depends on the package**, and the compiler discovers its providers, binds
them with the service's own providers, and generates a container that imports them from the
package.

| Workspace                                                        | Package                                 | What it is                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`packages/shared`](packages/shared)                             | `@znight-examples/shared`               | Source provider library: `Clock` + `SystemClock`, `IdGenerator`, `UserDirectory`, DTO schemas, user events contract |
| [`services/users-api`](services/users-api)                       | `@znight-examples/users-api`            | HTTP users CRUD on the Express adapter (`@znight/http/express`)                                                     |
| [`services/notifications-worker`](services/notifications-worker) | `@znight-examples/notifications-worker` | Message consumer (`@znight/messaging`) sending welcome / goodbye notifications                                      |

What it shows:

- **Source provider library**: `@znight-examples/shared` opts in from its `package.json`; every service
  depending on it gets its providers, with package tokens (`@znight-examples/shared#UserDirectory`)
  and imports through the package entry (`from '@znight-examples/shared'`), never through a path.
- **Injection by class, interface and abstract class** of library providers: `UserDirectory`,
  `Clock` (→ `SystemClock`), `IdGenerator`.
- **Overriding a library provider**: users-api declares a `@Primary()` `IdGenerator` (time-ordered
  UUIDv7). It wins everywhere, _including inside the library's own `UserDirectory`_: binding happens at
  build time over the whole application. The worker keeps the library default. Tests override
  library providers at runtime (`overrides: [[CLOCK, frozenClock]]`).
- **Shared contracts**: request bodies and message payloads validated by the same schemas, the queue
  name and message types read by the compiler across packages
  (`@Consumer(USER_EVENTS_QUEUE)`, `@OnMessage(UserEventType.Registered)`), domain errors mapped by each
  service at its own boundary (404/409 over HTTP, dead-letter in the worker).
- **The compiled-library flow**: the same library built in library mode (JavaScript +
  `dist/znight.providers.json`), installed into a copy of users-api, which compiles, type-checks,
  builds and runs against it ([below](#compiled-libraries)).
- Lifecycle hooks and graceful shutdown on Node.js and Bun, `@Config` classes, the Express adapter,
  TestBed / TestApp tests, end-to-end tests of the production builds.

```txt
examples/monorepo/
├─ packages/shared/                    @znight-examples/shared: "znight": { "library": "source" }
│  ├─ src/
│  │  ├─ index.ts                      public entry: every provider and referenced value is exported here
│  │  ├─ time/clock.ts                 Clock (interface), CLOCK (its runtime key), SystemClock (@Injectable)
│  │  ├─ ids/id-generator.ts           IdGenerator (abstract class), RandomIdGenerator (@Injectable)
│  │  ├─ users/user-directory.ts       UserDirectory (@Injectable): Clock + IdGenerator injected
│  │  ├─ users/user.ts                 User, CreateUserInput, UpdateUserInput schemas, domain errors
│  │  ├─ events/user-events.ts         USER_EVENTS_QUEUE, UserEventType, event payload schemas
│  │  └─ validation/schema.ts          a tiny Standard Schema toolkit (see "Shared schemas")
│  ├─ test/                            plain unit tests (no container needed)
│  └─ tsconfig.build.json              JavaScript + declarations for the compiled-library flow
└─ services/
   ├─ users-api/
   │  ├─ src/
   │  │  ├─ main.ts                    Application.create() + plugins + start()
   │  │  ├─ http.ts                    HttpPlugin (Express adapter, error mapper), shared with the tests
   │  │  ├─ api.config.ts              @Config('api'): PORT, USERS_SNAPSHOT_FILE, API_EXPOSE_ERRORS
   │  │  ├─ ids/sortable-id.generator.ts   @Primary() IdGenerator: overrides the library default
   │  │  ├─ users/user.controller.ts    GET/POST /users, GET/PATCH/DELETE /users/:id
   │  │  ├─ users/user-error.mapper.ts  UserNotFoundError → 404, EmailAlreadyUsedError → 409
   │  │  ├─ users/user-snapshot.ts     onStart: restore users, onStop: save them (graceful shutdown)
   │  │  └─ health/health.controller.ts    GET /health (Clock injected by interface)
   │  ├─ test/                         TestBed, TestApp, e2e, compiled-library flow
   │  ├─ vite.config.ts, znight.config.ts, bunfig.toml, tsconfig.json
   └─ notifications-worker/
      ├─ src/
      │  ├─ main.ts                    Application.create() + MessagingPlugin (in-memory broker)
      │  ├─ worker.config.ts           @Config('worker'): WORKER_STDIN_EVENTS, WORKER_HEARTBEAT_MS
      │  ├─ notifications/             UserEventsConsumer, NotificationService, NotificationChannel
      │  ├─ health/heartbeat.ts        liveness log, shutdown summary (onStart / onStop)
      │  └─ dev/stdin-event-source.ts  local runs without a broker: user events read from stdin
      ├─ test/                         TestBed, TestApp (in-memory broker), e2e
      └─ vite.config.ts, znight.config.ts, bunfig.toml, tsconfig.json
```

## Running it

The examples live in the Znight repository and use the framework packages from the workspace. From
the repository root, once:

```sh
bun install
bun run build     # builds the @znight/* packages: the znight CLI and Vite load their dist
```

Every service has the scripts of a `znight new` project:

| Script      | Does                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------- |
| `generate`  | `znight generate`: writes `src/.znight/container.generated.ts` (git-ignored)             |
| `dev`       | `znight dev`: build in watch mode, restart on change (also on `packages/shared` changes) |
| `build`     | `znight build`: production build, `dist/main.js` (the shared sources bundled in)         |
| `start`     | `znight start`: runs `dist/main.js` (`--runtime node` / `--runtime bun`)                 |
| `typecheck` | `znight generate && tsc --noEmit`                                                        |
| `test`      | `bun test` (the `bunfig.toml` preload regenerates the container first)                   |
| `test:e2e`  | `ZNIGHT_E2E=1 bun test`: unit tests + end-to-end tests of the production build           |

With npm, `npm run <script>` works the same (`npm start`); the tests always run on Bun (`bun:test`),
the application itself runs on Node.js or Bun. From the repository root,
`bun run --filter '@znight-examples/*' test` runs the tests of every example.

### users-api

```sh
cd services/users-api
bun run dev                          # or: npm run dev    (http://localhost:3000)

# production build, on Node.js or Bun
bun run build && bun run start       # or: npm run build && npm start
npx znight start --runtime bun       # force a runtime

# keep the users across restarts (saved on SIGTERM / Ctrl+C, restored at startup)
USERS_SNAPSHOT_FILE=.data/users.json bun run start
```

```sh
curl -i localhost:3000/users -H 'content-type: application/json' -d '{"email":"Ada@Example.com","name":"Ada"}'
# 201 Created, location: /users/0199f8a2-5b1e-7000-8a4c-... (a UUIDv7: SortableIdGenerator)
curl localhost:3000/users -H 'content-type: application/json' -d '{"email":"ada@example.com","name":"Again"}'
# 409 {"statusCode":409,"error":"Conflict","message":"Email ada@example.com is already used","details":{"email":"ada@example.com"}}
curl localhost:3000/users -H 'content-type: application/json' -d '{"email":"nope","name":""}'
# 400 {"statusCode":400,"error":"Bad Request","message":"Invalid body","details":[{"path":"email",...},{"path":"name",...}]}
curl 'localhost:3000/users?limit=10'                 # {"items":[...], "next": "<cursor>"} in creation order
curl 'localhost:3000/users?limit=10&after=<cursor>'
curl -X PATCH localhost:3000/users/<id> -H 'content-type: application/json' -d '{"name":"Ada Lovelace"}'
curl -X DELETE localhost:3000/users/<id>             # 204
curl localhost:3000/health                           # {"status":"ok","time":"...","users":1}
```

### notifications-worker

The worker uses the in-memory broker (`memory()`): swap it for `rabbitmq()`, `sqs()` or `kafka()`
from `@znight/messaging/<driver>` (and install its client) in production. To try it locally, let it
read the user events from stdin, one JSON object per line:

```sh
cd services/notifications-worker
bun run build
WORKER_STDIN_EVENTS=true bun run start     # or: WORKER_STDIN_EVENTS=true npm start
{"type":"user.registered","payload":{"id":"u1","email":"ada@example.com","name":"Ada","at":"2026-01-01T00:00:00Z"}}
{"type":"user.deleted","payload":{"id":"u1","at":"2026-01-02T00:00:00Z"}}
{"type":"user.registered","payload":{"id":"u2","name":"no email"}}
# Ctrl+C: consumers drain, then "Notifications worker stopped" {"sent":2}
```

Each event is published through `MessageBroker` (like a producer service would), validated by the
shared schema and handled by `UserEventsConsumer`: a welcome notification, a goodbye notification
(the address comes from the worker's own `UserDirectory`, a projection of the events), and the
invalid one is dead-lettered (`user-events.dlq`). Notifications are logged by
`LogNotificationChannel` (one JSON line each).

## How it works

### 1. The library opts in

```jsonc
// packages/shared/package.json
{
  "name": "@znight-examples/shared",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@znight/core": "workspace:*" },
  "znight": { "apiVersion": 1, "library": "source" }
}
```

`"library": "source"` asks the compiler of every package **depending** on it to scan its sources
(the `include`/`exclude` globs applied inside the package, plus its entry). The services need no
option: depending on the package is enough (`libraries: ['@acme/pkg']` in the compiler options does
the same for a package without the manifest entry).

The library's providers are ordinary classes:

```ts
// packages/shared/src/users/user-directory.ts
@Injectable()
export class UserDirectory {
  constructor(
    private readonly clock: Clock, // an interface
    private readonly ids: IdGenerator, // an abstract class
  ) {}
}
```

Rules for a provider library: every provider (and every value a decorator references) is exported
by a public entry, since generated code imports it from there; the library depends on `@znight/core`
for the decorators only (they are no-ops at runtime).

### 2. What the compiler generates

`services/users-api/src/.znight/container.generated.ts` (excerpt):

```ts
import { CreateUserInput, SystemClock, UpdateUserInput, UserDirectory } from '@znight-examples/shared'
import { SortableIdGenerator } from '../ids/sortable-id.generator.js'

export const __ZNIGHT_METADATA__: ZnightMetadata = {
  providers: {
    ['@znight-examples/shared#SystemClock']: {
      scope: 'singleton',
      class: SystemClock,
      deps: [],
      factory: () => new SystemClock(),
    },
    ['@znight-examples/shared#UserDirectory']: {
      scope: 'singleton',
      class: UserDirectory,
      deps: ['@znight-examples/shared#SystemClock', 'src/ids/sortable-id.generator.ts#SortableIdGenerator'],
      factory: d => new UserDirectory(d[0], d[1]),
    },
    // ... SortableIdGenerator (primary: true), controllers, ApiConfig, UserSnapshot...
  },
  aliases: {
    ['@znight-examples/shared#Clock']: '@znight-examples/shared#SystemClock',
    ['@znight-examples/shared#IdGenerator']: 'src/ids/sortable-id.generator.ts#SortableIdGenerator',
  },
  // ... the routes, whose invoke() validate the bodies with CreateUserInput / UpdateUserInput
}
```

- Library providers get **package tokens** (`<package>#<export>`), application providers
  `<path>#<class>`. Tokens never depend on where the package is installed.
- Imports go through the **package specifier**. In a build, Vite bundles the linked workspace (the
  `znight()` plugin strips the decorators of the shared sources too); a package installed from a
  registry would stay external.
- The worker's container has the same three library providers, with `RandomIdGenerator` bound to
  `IdGenerator`.
- users-api compiles with `prune: true` (`znight.config.ts`): `RandomIdGenerator`, superseded by the
  `@Primary` and used by nothing, is left out of its container, and therefore out of its bundle.

`test/container.test.ts` of users-api checks exactly this.

### 3. Injecting library providers

| Injection point                         | Kind           | Bound to                                                                    |
| --------------------------------------- | -------------- | --------------------------------------------------------------------------- |
| `constructor(directory: UserDirectory)` | class          | `UserDirectory` (the class is the provider)                                 |
| `constructor(clock: Clock)`             | interface      | its only implementation, `SystemClock`                                      |
| `constructor(ids: IdGenerator)`         | abstract class | `RandomIdGenerator` (worker), `SortableIdGenerator` (users-api, `@Primary`) |

Injection types are types: `import type { UserDirectory } from '@znight-examples/shared'` is enough
(the compiler resolves it, nothing is referenced at runtime). Interfaces have no runtime value, so
the library exports a typed key for the places that need one: `CLOCK = token<Clock>('@znight-examples/shared#Clock')`
(`app.get(CLOCK)`, `mocks.get(CLOCK)`, `overrides: [[CLOCK, fake]]`); an abstract class like
`IdGenerator` is its own key.

### 4. Overriding a library provider

```ts
// services/users-api/src/ids/sortable-id.generator.ts
@Primary()
@Injectable()
export class SortableIdGenerator extends IdGenerator {
  constructor(private readonly clock: Clock) {
    super()
  }
  next(): string {
    /* UUIDv7 */
  }
}
```

`IdGenerator` now has two candidates in users-api: `RandomIdGenerator` (library) and
`SortableIdGenerator` (local, `@Primary`). The compiler binds **every** `IdGenerator` injection point
to the primary one, the one of the library's `UserDirectory` included, so users get time-ordered
ids and `GET /users` pages in creation order. Without `@Primary()`, the build fails, pointing into
the library:

```
✗ ZNIGHT008: Ambiguous injection of 'IdGenerator' required by UserDirectory: 2 candidates (RandomIdGenerator (../../packages/shared/src/ids/id-generator.ts:21), SortableIdGenerator (src/ids/sortable-id.generator.ts:18))
  --> ../../packages/shared/src/users/user-directory.ts:46:27
   |
46 |     private readonly ids: IdGenerator,
   |                           ^^^^^^^^^^^
   = hint: Mark the provider to inject by default with @Primary()
   = hint: Or name the providers with @Named('...') and choose one with @Inject('...')
```

Other ways to replace a library provider:

- **at runtime**, for tests: `TestApp.create({ overrides: [[CLOCK, frozenClock]] })` (every consumer
  of `Clock`, library providers included, receives the fake);
- an interface with **no** implementation in the library: the application must provide one
  (ZNIGHT001 at build time otherwise), e.g. a `Mailer` the library uses but does not implement.

### 5. Shared schemas

`@Body(schema)` (`@znight/http`) and `@Message(schema)` (`@znight/messaging`) accept any
[Standard Schema](https://standardschema.dev): Zod, Valibot, ArkType... The shared package keeps a
single dependency (`@znight/core`), so its DTOs use a tiny Standard Schema toolkit
(`validation/schema.ts`) that both services consume, whatever validation library they use themselves
(users-api validates its query parameters with a local Zod schema). In your monorepo, sharing Zod
schemas works the same way: add `zod` to the shared package dependencies.

```ts
// packages/shared/src/users/user.ts
export interface CreateUserInput {
  readonly email: string
  readonly name: string
}
export const CreateUserInput: Schema<CreateUserInput> = object<CreateUserInput>({ email: email(), name: text({ max: 100 }) })

// services/users-api/src/users/user.controller.ts
@Post()
create(@Body(CreateUserInput) input: CreateUserInput) { ... }

// services/notifications-worker/src/notifications/user-events.consumer.ts
@Consumer(USER_EVENTS_QUEUE)                                   // 'user-events', read across packages
export class UserEventsConsumer {
  @OnMessage(UserEventType.Registered)                         // 'user.registered'
  async registered(@Message(UserRegistered) event: UserRegistered) { ... }
}
```

## Tests

| Workspace            | Test                                                     | Tool                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared               | `user-directory.test.ts`, `schemas.test.ts`              | plain unit tests: providers are classes, no container needed                                                                                                              |
| users-api            | `sortable-id.generator.test.ts`, `user-snapshot.test.ts` | `TestBed`: real factory, auto-mocked dependencies (library providers included), `config` values                                                                           |
| users-api            | `users.http.test.ts`                                     | `TestApp`: the real app, in-memory HTTP through the Express adapter, `CLOCK` overridden                                                                                   |
| users-api            | `container.test.ts`                                      | the generated container (package tokens, imports, `@Primary` binding)                                                                                                     |
| users-api            | `e2e.test.ts` (`ZNIGHT_E2E=1`)                           | `znight build`, then `znight start --runtime node` and `--runtime bun`: CRUD over HTTP, SIGTERM → exit 0, snapshot saved by `onStop` and restored by `onStart` on restart |
| users-api            | `compiled-library.test.ts` (`ZNIGHT_E2E=1`)              | [the compiled-library flow](#compiled-libraries)                                                                                                                          |
| notifications-worker | `notification.service.test.ts`                           | `TestBed` (an interface mock looked up by name: `mocks.get<NotificationChannel>('NotificationChannel')`)                                                                  |
| notifications-worker | `user-events.consumer.test.ts`                           | `TestApp` + `memory()` driver: handling, idempotency, retries, dead letters                                                                                               |
| notifications-worker | `e2e.test.ts` (`ZNIGHT_E2E=1`)                           | `znight build`, then the worker on Node.js and Bun fed through stdin, SIGTERM → exit 0, shutdown hooks ran                                                                |

```sh
cd services/users-api && bun run test:e2e    # ~3 s
cd services/notifications-worker && bun run test:e2e
```

## Compiled libraries

The source flow above suits a monorepo: no build step, one source of truth. A library **published**
to a registry ships JavaScript instead, and declarations lose what the compiler needs (decorators:
scopes, qualifiers, `@Primary`, injection points). Library mode records it:

1. **Build the library**: JavaScript and declarations (`bun run build` in `packages/shared`:
   `tsc -p tsconfig.build.json` → `dist/`), then the provider metadata:

   ```ts
   import { generate } from '@znight/compiler'

   await generate({ root: 'packages/shared', library: true, mode: 'build' }) // → dist/znight.providers.json
   ```

   `znight.providers.json` lists every provider with its package token, import route
   (`{ specifier: '@znight-examples/shared', exportName: 'UserDirectory' }`), scope, heritage and
   injection points (`Clock`, `IdGenerator`): what an application needs to bind them.

2. **Publish** a manifest pointing to the build and to the metadata:

   ```jsonc
   {
     "name": "@znight-examples/shared",
     "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
     "dependencies": { "@znight/core": "^0.1.0" },
     "znight": { "apiVersion": 1, "providers": "./dist/znight.providers.json" }
   }
   ```

3. **Consume it**: nothing changes in the application. The compiler finds the providers in the
   declarations (`dist/*.d.ts`), merges the metadata, and binds the library's dependencies against
   the application's providers: the `@Primary` `SortableIdGenerator` of users-api is still injected
   into the compiled `UserDirectory`. The library's JavaScript stays external to the bundle and is
   loaded from `node_modules`.

`services/users-api/test/compiled-library.test.ts` plays the three steps: it builds the library,
stages the published package in a temporary copy of users-api (`node_modules/@znight-examples/shared`
is then that package instead of a link to the sources), and checks that the copy compiles (no
diagnostics, providers taken from the declarations, generated imports from `'@znight-examples/shared'`,
the `@Primary` binding), type-checks against the declarations, builds and serves `POST /users` on
Node.js and Bun.

```sh
cd services/users-api && ZNIGHT_E2E=1 bun test test/compiled-library.test.ts
```

It stages a copy because, in this monorepo, `@znight-examples/shared` stays a source library: its
manifest has no `providers` entry and its entry point is TypeScript. (A single package can carry
both: `"library": "source"` only applies when its entry resolves to TypeScript with the scan
conditions, e.g. a source export condition used inside the monorepo, otherwise the `providers`
metadata is used. This example does not exercise that combination.) Library mode refuses providers
with extension-generated factories (`@Config` classes): publish such libraries as source libraries,
and its build needs `@znight/compiler` (here the test drives it from users-api, which has it).

## Notes for this repository

- `tsconfig.json` sets `customConditions: ["@znight/source"]`, so that `tsc` reads the `@znight/*`
  workspace packages from their sources; a project installing Znight from npm does not need it.
- `vite.config.ts` lists the `@znight/*` packages in `ssr.external`: in this repository they are linked
  workspaces, which Vite would bundle; installed from npm they are external by default.
- The CLI and Vite load the framework from its `dist`: run `bun run build` at the root first.
- users-api does not publish user events (it would need `@znight/messaging`): the two services share
  the contract (queue, types, schemas), not a broker. In production, add `MessagingPlugin` to
  users-api and publish `user.registered` / `user.deleted` from the controller or a service.
