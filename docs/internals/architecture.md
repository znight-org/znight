# Znight architecture

This document is the technical specification of Znight. It is the contract between the packages:
the compiler generates code that the runtime packages consume, so both sides MUST follow it. When
an implementation needs to deviate, update this document in the same change.

Normative words (MUST, SHOULD, MAY) are used in their RFC 2119 sense.

## 1. Principles

1. **Compile-time DI.** The compiler (`@znight/compiler`, a Vite plugin + a programmatic API)
   parses the application with [oxc](https://oxc.rs), resolves every injection point to a concrete
   provider, validates the graph and generates a plain TypeScript module (`__ZNIGHT_METADATA__`).
   No `reflect-metadata`, no `emitDecoratorMetadata`, no runtime type lookup.
2. **Decorators are markers.** Every Znight decorator is a no-op function at runtime. The compiler
   reads them from the AST; the Vite plugin strips them from the bundle by default.
3. **Flat DI.** One global container, no modules. Providers are discovered by scanning sources
   (application and provider libraries).
4. **Composable.** Each feature (HTTP, messaging, config, observability) is a separate package made
   of marker decorators + an optional compiler extension (`@znight/<pkg>/compiler`) + a runtime
   plugin (`XxxPlugin.configure()`).
5. **Runtime agnostic.** Runtime packages run on Node.js >= 24 and Bun >= 1.3 (ESM only) and only
   rely on standard APIs (`node:async_hooks`, `fetch`, `node:util`, `Symbol.asyncDispose`...).
6. **Fast.** Native parser/resolver, per-file caches keyed by content hash, global recomputation of
   the (cheap) binding phase. At runtime: generated factories called in a precomputed order,
   independent async singletons initialised concurrently.
7. **Fail loudly, early, precisely.** Every misconfiguration that can be detected at build time is a
   `ZNIGHTxxx` diagnostic with a source location and hints. Runtime errors carry a code, the
   dependency path and the original `cause`.

## 2. Repository layout & conventions

```
packages/
  core/           runtime: container, application, plugins, hooks, AOP, scope, decorators, errors
  compiler/       Vite plugin + programmatic API (+ Bun preload): analysis, binding, validation, codegen
  http/           decorators, compiler extension, HttpPlugin, adapters (fastify, express, hono)
  messaging/      decorators, compiler extension, MessagingPlugin, drivers (memory, rabbitmq, sqs, kafka)
  config/         decorators, compiler extension, ConfigPlugin, loaders (env, dotenv, json, yaml, vault, aws)
  observability/  Logger (pino), metrics (prom-client), tracing (OpenTelemetry), ObservabilityPlugin
  testing/        TestBed (auto-mocking), TestApp (e2e), mock helpers
  cli/            `znight` binary: new, generate, dev, build, start
examples/         runnable example applications (also used by end-to-end tests)
docs/             VitePress documentation site
```

Tooling: bun workspaces (+ catalogs), TypeScript 7 (`tsc --noEmit`), tsdown (build), Biome (lint +
format), `bun test` (tests). All `@znight/*` packages are versioned in lockstep.

### Source condition

Each package exposes a `@znight/source` export condition pointing to its TypeScript sources, before
`types`/`default` (dist). Repository scripts pass `--conditions=@znight/source` so packages are used
from source without building. Framework sources MUST be directly executable by Node 24 (type
stripping) and Bun:

- relative imports use the `.ts` suffix (`import { Container } from './container.ts'`);
- `erasableSyntaxOnly`: no parameter properties, enums, namespaces or decorators in package `src/`
  (tests and examples may use them);
- `isolatedDeclarations`: every exported function / class member has an explicit type.

Each package has `tsconfig.json` (sources, strict library settings) and `test/tsconfig.json` (tests,
Bun types, decorators allowed). `typecheck` runs both.

### Package conventions

- `src/index.ts` is the public runtime entry. Additional entries (`src/compiler/index.ts`,
  `src/adapters/fastify.ts`...) are declared in `tsdown.config.ts` **and** `package.json#exports`
  with the same `@znight/source` / `types` / `default` triple.
- Tests: `packages/<pkg>/test/**/*.test.ts` with `bun:test`; fixtures in `test/fixtures/`.
- Third-party integrations (fastify, amqplib, pino...) are **optional peer dependencies** (plus exact
  devDependencies for tests) unless the package cannot work without them. Adapters and drivers live
  in subpath exports. Runtime `dependencies`/`peerDependencies` use caret ranges.
- Boundaries (enforced by a repository test):
  - `<pkg>/compiler` entries only `import type` from `@znight/compiler` and never import the
    package's runtime entry (so building never loads fastify, amqplib...);
  - runtime entries never import `./compiler`;
  - `@znight/compiler` is at most an optional peer of feature packages.

## 3. Runtime metadata

Exact types: [`packages/core/src/metadata.ts`](../../packages/core/src/metadata.ts).

### 3.1 Tokens

A **token** is the canonical identity (§4.1) of the declaration that defines the provider:

| Provider                    | Token                            | Example                                     |
| --------------------------- | -------------------------------- | ------------------------------------------- |
| Class in the application    | `<path>#<ClassName>`             | `src/users/user.service.ts#UserService`     |
| Class exported by a package | `<package>#<ExportName>`         | `@acme/auth#JwtService`                     |
| `@Provides` method          | `<factory class token>.<method>` | `src/db/db.factory.ts#DbFactory.createPool` |
| External (plugin-provided)  | `<package>#<ExportName>`         | `@znight/observability#Logger`              |

Tokens never change when unrelated code is added, cannot collide across files or packages, and
are namespaced for externals. The **display name** of a token is the part after the last `#`
(`UserService`, `DbFactory.createPool`); it is used in messages. `container.get('UserService')`
accepts a display name when it is unique, and throws listing the candidates otherwise. The public
API is class-first: `container.get(UserService)`.

### 3.2 Shape

```ts
interface ZnightMetadata {
  version: 1 // metadata format, checked by Container.create
  compiler?: string // @znight/compiler version that produced it
  providers: Record<Token, ProviderDefinition>
  resolutionOrder: Token[] // topological (dependencies first), deterministic
  aliases?: Record<Token, Token> // provided-type identity / interface / base class -> provider token
  externals?: ExternalDefinition[] // tokens supplied at runtime by plugins
  extensions?: { http?: HttpMetadata; messaging?: MessagingMetadata; config?: ConfigMetadata }
}

interface ProviderDefinition {
  scope: 'singleton' | 'request' | 'transient'
  class?: Constructor // enables container.get(Class)
  deps: DependencyRef[] // Token | { token, optional: true } | { multi: Token[] } | { lazy: Token }
  factory: (deps: any[]) => T | Promise<T>
  async?: boolean // factory returns a promise (singletons only)
  interceptors?: Record<method, { async: boolean; chain: { dep: number; options?: unknown }[] }>
  dispose?: string // method to call on shutdown (@Provides({ dispose }))
  name?: string // @Named qualifier
  primary?: boolean
  source?: { file; line; column } // omitted in production builds by default
}

interface ExternalDefinition {
  token
  scope?: Scope
  providedBy?: string
  optional?: boolean
}
```

`Lazy<T>` (`{ lazy: Token }`) injects `{ get(): T }`, resolved at call time in the current scope.
It is the escape hatch for ZNIGHT002 (cycles) and ZNIGHT003 (a singleton needing a request-scoped
value).

### 3.3 Generated module

`src/.znight/container.generated.ts` (option `outFile`). Example:

```ts
// AUTO-GENERATED by @znight/compiler 0.1.0. Do not edit.
// biome-ignore-all lint: generated file
/* eslint-disable */
import type { ZnightMetadata } from '@znight/core'
import type { HttpContext } from '@znight/http'
import { coerce } from '@znight/http'
import { UserController } from '../users/user.controller.js'
import { UserService } from '../users/user.service.js'
import { PgUserRepository } from '../users/pg-user.repository.js'

export const __ZNIGHT_METADATA__: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {
    ['src/users/pg-user.repository.ts#PgUserRepository']: {
      scope: 'singleton',
      class: PgUserRepository,
      deps: ['src/db/db.factory.ts#DbFactory.createPool'],
      factory: d => new PgUserRepository(d[0]),
    },
    ['src/users/user.service.ts#UserService']: {
      scope: 'singleton',
      class: UserService,
      deps: [
        'src/users/pg-user.repository.ts#PgUserRepository',
        '@znight/observability#Logger',
        '@znight/observability#LoggedInterceptor',
      ],
      factory: d => new UserService(d[0], d[1]),
      interceptors: { findById: { async: true, chain: [{ dep: 2, options: { level: 'debug' } }] } },
    },
    ['src/users/user.controller.ts#UserController']: {
      scope: 'singleton',
      class: UserController,
      deps: ['src/users/user.service.ts#UserService'],
      factory: d => new UserController(d[0]),
    },
  },
  resolutionOrder: [
    'src/users/pg-user.repository.ts#PgUserRepository',
    'src/users/user.service.ts#UserService',
    'src/users/user.controller.ts#UserController',
  ],
  aliases: { ['src/users/user.repository.ts#UserRepository']: 'src/users/pg-user.repository.ts#PgUserRepository' },
  externals: [
    { token: '@znight/observability#Logger', providedBy: 'ObservabilityPlugin' },
    { token: '@znight/observability#LoggedInterceptor', providedBy: 'ObservabilityPlugin' },
  ],
  extensions: {
    http: {
      controllers: [
        {
          token: 'src/users/user.controller.ts#UserController',
          basePath: '/users',
          guards: [],
          interceptors: [],
          meta: {},
          routes: [
            {
              method: 'GET',
              path: '/:id',
              fullPath: '/users/:id',
              handler: 'getUser',
              meta: { roles: ['admin'] },
              guards: ['src/auth/auth.guard.ts#AuthGuard'],
              interceptors: [],
              params: [{ index: 0, source: 'param', name: 'id', type: 'number' }],
              invoke: (c: UserController, ctx: HttpContext) => c.getUser(coerce.number(ctx.params['id'], 'param "id"')),
            },
          ],
        },
      ],
    },
  },
}
export default __ZNIGHT_METADATA__
```

Rules for generated code:
- Deterministic: no timestamps; output order derived from canonical identities only. A full
  compile and any sequence of incremental compiles produce byte-identical output, and output is
  identical with or without the `@znight/source` condition and on every OS.
- Object keys are always computed string keys (`["..."]`); values are produced by a single literal
  emitter (handles `undefined`, `NaN`, `±Infinity`, `-0`, bigint, nested objects/arrays; rejects
  functions, symbols and cycles). Extensions never splice raw strings (§6.5).
- Imports use **import routes** (§4.2). Identifiers are validated and de-duplicated by identity order
  (`UserService`, `UserService$1`).
- The code MUST type-check under strict user settings (`strict`, `noUnusedLocals`,
  `noUnusedParameters`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`): zero-dependency factories are `() => new X()`, index access uses
  brackets, etc. `invoke` keeps typed parameters so handler signatures are type-checked.
- After assembly the compiler re-parses the module with oxc; a syntax error is a compiler bug
  reported with the name of the extension that produced the faulty section.
- `source` locations are emitted in `serve`/`test`, omitted in `build` (option `sourceLocations:
  'dev' | 'always' | false`).
- Git policy: the generated file is ignored; `znight generate` (or the Vite plugin / Bun preload)
  creates it before `tsc` and tests. `znight generate --check` exits 1 when the file is stale.

## 4. Compiler: identities, resolution, binding

### 4.1 Canonical identity

Every declaration the compiler reasons about (classes, interfaces, type aliases, consts, decorator
functions) has a canonical identity string:

- **Application declarations** (file owned by the application root package): `<path>#<Name>`,
  where `<path>` is the realpath relative to the project root with POSIX separators and the exact
  on-disk casing, and `<Name>` the local declaration name. An import whose casing differs from the
  file on disk is a warning (ZNIGHT010 hint).
- **Package declarations** (nearest `package.json` of the resolved realpath has a `name` different
  from the root package): `<package name>#<ExportName>`, where `ExportName` is the name under which
  the package's **public entry** (root entry, or the subpath entry when the root does not export it)
  exports the declaration. It is computed by parsing the package entry (`.ts`, `.d.ts`, `.d.mts`)
  and following re-exports _inside_ the package; re-exports into another package continue with that
  package's rules. The result is independent of symlinks, `node_modules` layout and conditions.
- Member access on a default/namespace import (`import pg from 'pg'; pg.Pool`) maps to `pg#Pool`.
- Declarations only exported from a subpath entry: `<package>/<subpath>#Export` (the root entry wins
  when it exports the declaration too). `@types/x` maps to `x`. Namespace members use a dotted path
  (`@lib#tokens.Holder`). Package-internal (non-exported) declarations get
  `<package>/<relpath>#Name` and are never valid import routes. Node built-ins and untyped packages:
  `node:events#EventEmitter`, `cjs-only#Thing`; globals: `globalThis#Date`.
- Known limitation: a `const` widened by declaration emit (`PREFIX: string` in `.d.ts`) evaluates
  to a value from sources but to a reference from `dist`.
- Compiler options that name types (`externals`) take identities, never bare names.

Golden test: compiling `examples/*` with and without `@znight/source` yields identical identities
and byte-identical generated output.

### 4.2 Import routes

Every value the generated module needs (provider classes, schemas, guards, helpers) has an import
route `(specifier, exportName | 'default')`:
- application file: relative path from `outFile`, extension mapped (`.ts`/`.tsx` → `.js`, `.mts` →
  `.mjs`, `.cts` → `.cjs`; option `importExtension: 'js' | 'ts' | 'none'`), exported name actually
  exported by that module (alias-aware; re-exporting module when it is only re-exported there);
- package declaration: bare specifier of the public entry + public export name. Never a path into
  another package.
- Routes always point to the declaring module (an ESM barrel can only re-export what the declaring
  module exports). CommonJS packages (`export =`, untyped) are imported through `default` plus a
  member path.
- A provider or referenced value that is not exported (or an anonymous default export) is
  ZNIGHT005 with the fix-it "export it".

### 4.3 Resolution

oxc-resolver configured with: the nearest tsconfig of each importing file (`paths`), the Vite
`resolve.alias` (string aliases) and `resolve.conditions` when running inside Vite,
`extensionAlias` (`.js` → `.ts/.tsx/.js`, `.mjs` → `.mts/.mjs`, `.cjs` → `.cts/.cjs`), and two
condition sets: **scan conditions** (may include `@znight/source`, used to find sources to analyse)
and **runtime conditions** (used for import routes and loading extensions). The resolver cache is
cleared on file create/unlink/rename and on any `package.json`/`tsconfig*.json`/lockfile change.

### 4.4 Types

`TypeInfo` = `primitive` (`string|number|boolean|bigint|symbol|null|undefined|void|any|unknown|never|object`)
| `literal` | `reference { identity, name, typeArgs }` | `array { element }` | `tuple` | `union` |
`intersection` | `promise { inner }` | `opaque { text }`.

Normative serialization (used inside identities and to compare types):
- primitives by keyword, literals as JSON; `Array<T>`, `ReadonlyArray<T>`, `readonly T[]` → `T[]`;
- unions/intersections flattened, de-duplicated and sorted by serialization;
- default type arguments filled from the declaration; generic aliases expanded with substitution
  (`type UserRepo = Repository<User>`);
- object literal types, function types, mapped/conditional types, `typeof`, `import()` types are
  opaque. Opaque in an injection type → ZNIGHT010.

### 4.5 Class analysis

- **Constructor**: the nearest class in the `extends` chain declaring a constructor (resolved
  through imports and identities); type parameters substituted with heritage type arguments; that
  declaration's parameter decorators apply. If the chain hits something unanalysable (call
  expression `extends Mixin(Base)`, a package class without parseable declaration) → ZNIGHT010
  "declare an explicit constructor".
- **Heritage closure**: all `extends`/`implements` identities with substituted type arguments,
  transitively (classes and interfaces).
- **Lifecycle**: `onStart`/`onReady`/`onStop` (and `[Symbol.asyncDispose]`/`[Symbol.dispose]`) found on
  the class or its analysable bases. Used for ZNIGHT009 only; the runtime duck-types instances.
- `@Injectable` on a class with unbound type parameters → ZNIGHT005 ("subclass with concrete type
  arguments or use @Provides").

### 4.6 Decorators and static evaluation

A decorator is recognised by the canonical identity of its callee (resolved like types: renamed
imports, barrels, `export *`, namespace imports `@zn.Get()`). Compiler extensions declare the
identities they own (e.g. `@znight/http#Get`). A local function whose body returns a call to a
Znight decorator gets a ZNIGHT005 warning ("composite decorators are not visible to the compiler").

Each decorator parameter is declared **static** (paths, names, scopes, queue names, env names: MUST
evaluate) or **value** (schemas, guards, defaults, options: evaluated when possible, otherwise MUST
be a reference to an exported binding, imported by the generated module).

The static evaluator accepts: literals (incl. unary `-`/`+`/`!`), binary arithmetic and string
concatenation, `??`, `||`, `&&`, template literals with evaluable expressions, property/element
access on evaluated objects/arrays, `as const`, `satisfies`, parentheses, non-null assertions,
spreads of evaluated values, and `const` references across files and packages (cycle-guarded).
Each evaluation records the files it read (for invalidation). Non-evaluable static argument or
inline non-evaluable value argument → ZNIGHT005 with the fix-it "extract to `export const X = ...`".

### 4.7 Binding algorithm (normative)

For an injection point with type `T` (identity), optional qualifier `q` (`@Inject('q')`), flags
optional / multi / lazy:

1. `C = exact(T) ∪ assignable(T)` where _exact_ are providers whose **provided type** is `T`, and
   _assignable_ those whose heritage closure contains `T`.
2. With a qualifier: `C = C ∩ named(q)` (`@Named(q)` / `@Provides({ name: q })`).
3. Multi (`T[]`): all of `C`, ordered by token. Never fails.
4. Single: one exact candidate → bound; else the unique `@Primary` → bound; else if `C` has several
   candidates all providing the exact same type → ZNIGHT004, several otherwise → ZNIGHT008.
5. Empty `C`: package type declared in a manifest `provides` (§7) → external; optional (`?`,
   `| undefined`, `| null`, default value, `@Optional()`) → `{ token, optional: true }` where the
   token is the identity; else ZNIGHT001.
6. Primitive/opaque types require a qualifier; providers are matched by `(qualifier, type kind)`.
   A qualifier match providing a different kind → ZNIGHT010.
7. `Lazy<T>` binds `T` with the same rules and emits `{ lazy: token }`.

ZNIGHT001 includes a **near-miss analysis**: classes with the same name but a different identity
(both import paths shown), an undecorated class of type `T`, a matching class excluded by
`include`/`exclude`, a class with a matching name but no `implements` clause, candidates removed by
the qualifier. Messages show display names (`Repository<User>`) plus `file:line`, never raw
identity strings alone.

Aliases are emitted for every provided type / heritage identity that resolves to exactly one
provider (or one primary), so `container.get(UserRepository as never)` / `get('UserRepository')` work.

### 4.8 Validations

| Code      | Meaning                                                                                                                                                                                                                                                                                            | Severity                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| ZNIGHT001 | Missing provider for a required dependency                                                                                                                                                                                                                                                         | error                                   |
| ZNIGHT002 | Circular dependency (over the full edge set, prints the cycle, hints at `Lazy<T>`)                                                                                                                                                                                                                 | error                                   |
| ZNIGHT003 | Scope mismatch: a singleton depends (directly, through transients, multi, guards, interceptors or externals) on a request-scoped provider                                                                                                                                                          | error                                   |
| ZNIGHT004 | Duplicate provider for the exact same type without qualifier/`@Primary`                                                                                                                                                                                                                            | error                                   |
| ZNIGHT005 | Invalid decorator usage (target, arguments, unexported reference, non-public/`#private`/static handler or `@Provides`, abstract or unbound generic provider, class registered by several provider decorators, `@Provides` outside `@Factory` or without concrete return type, composite decorator) | error / warning                         |
| ZNIGHT006 | Missing required configuration value (runtime)                                                                                                                                                                                                                                                     | error                                   |
| ZNIGHT007 | Invalid route (path grammar, duplicate method+path, `:param` without `@Param`, non-coercible param type)                                                                                                                                                                                           | error                                   |
| ZNIGHT008 | Ambiguous injection (several candidates for an interface / base type)                                                                                                                                                                                                                              | error                                   |
| ZNIGHT009 | Invalid lifecycle hook (required params, static; on a non-singleton → warning)                                                                                                                                                                                                                     | error / warning                         |
| ZNIGHT010 | Unresolvable injection type (missing/opaque annotation, primitive without qualifier, unresolvable import, unanalysable inherited constructor)                                                                                                                                                      | error                                   |
| ZNIGHT011 | Invalid message consumer (no handler, overlapping patterns, bad retry options)                                                                                                                                                                                                                     | error                                   |
| ZNIGHT012 | Invalid config property (unsupported type, `@Env` outside `@Config`)                                                                                                                                                                                                                               | error                                   |
| ZNIGHT013 | Request-scoped provider resolved outside of a request scope (runtime)                                                                                                                                                                                                                              | error                                   |
| ZNIGHT014 | Async factory on a non-singleton provider                                                                                                                                                                                                                                                          | error                                   |
| ZNIGHT015 | Provider instantiation failed (runtime; carries dependency path, source, cause)                                                                                                                                                                                                                    | error                                   |
| ZNIGHT016 | Container sealed: register/override after `init()` (runtime)                                                                                                                                                                                                                                       | error                                   |
| ZNIGHT017 | Unvalidated input: non-primitive `@Body`/`@Query`/`@Message` without schema                                                                                                                                                                                                                        | warning (error with `strictValidation`) |
| ZNIGHT018 | Version mismatch (metadata version, `@znight/*` minor skew, extension `apiVersion`)                                                                                                                                                                                                                | error                                   |
| ZNIGHT019 | Unused provider (unreachable from roots, see `prune`)                                                                                                                                                                                                                                              | warning (only with `reportUnused`)      |
| ZNIGHT020 | The generated module is imported (transitively) by a provider module (ESM cycle → TDZ crash)                                                                                                                                                                                                       | error                                   |
| ZNIGHT021 | Lifecycle hook or shutdown step failed or timed out (runtime)                                                                                                                                                                                                                                      | error                                   |
| ZNIGHT022 | Syntax error: a scanned source file could not be parsed (reported first; the file is skipped)                                                                                                                                                                                                      | error                                   |

Singleton → transient is allowed (the singleton owns its instance). Error codes and descriptions
live in `@znight/core` (`ErrorCode`, `ERROR_DESCRIPTIONS`), shared by compiler and runtime.

## 5. Decorator catalogue

`static` = must be statically evaluable, `value` = evaluable or exported reference (§4.6).

### `@znight/core`

| Decorator                           | Target                              | Arguments                                                                                                                                                             |
| ----------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Injectable(opts?)`                | class                               | `opts` static: `{ scope?, name?, primary? }`                                                                                                                          |
| `@Factory()`                        | class                               | — singleton whose `@Provides` methods produce providers                                                                                                               |
| `@Provides(opts?)`                  | method of a `@Factory`              | static `{ scope?, name?, primary?, dispose? }`. The explicit return type is the provided type (`Promise<T>` → async, singleton only). Method parameters are injected. |
| `@Inject(name)`                     | constructor / `@Provides` parameter | static string qualifier                                                                                                                                               |
| `@Optional()`                       | constructor / `@Provides` parameter | —                                                                                                                                                                     |
| `@Named(name)`                      | class / `@Provides` method          | static string                                                                                                                                                         |
| `@Primary()`                        | class / `@Provides` method          | —                                                                                                                                                                     |
| `@Intercept(Interceptor, options?)` | method                              | `Interceptor` value (provider class implementing `MethodInterceptor`), `options` value                                                                                |

Type helpers: `Lazy<T>`; lifecycle interfaces `OnStart`, `OnReady`, `OnStop`.

### `@znight/http`

| Decorator                                                                            | Target                                                                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@Controller(path? \| { path?, scope? })`                                            | class (provider, default singleton)                                                            |
| `@Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All(path?)`                          | method                                                                                         |
| `@Param(name?, schema?)` `@Query(name?, schema?)` `@Body(schema?)` `@Headers(name?)` | param                                                                                          |
| `@Req()` `@Res()` `@Ctx()`                                                           | param (raw request, raw response — adapter-specific escape hatch, warning — and `HttpContext`) |
| `@HttpCode(status)` `@Header(name, value)`                                           | method                                                                                         |
| `@UseGuard(...guards)` `@UseInterceptor(...interceptors)`                            | class / method (value refs)                                                                    |
| `@Validate(schema)`                                                                  | method — sugar for `@Body(schema)`; using both is ZNIGHT005                                    |
| `createRouteDecorator<T>(key)`                                                       | user-defined metadata decorators (`@Roles('admin')`, `@Public()`) → `route.meta[key]`          |

### `@znight/messaging`

| Decorator                                                                | Target                                    |
| ------------------------------------------------------------------------ | ----------------------------------------- |
| `@Consumer(queue \| { queue, scope?, concurrency?, ...driver options })` | class (provider)                          |
| `@OnMessage(type?)`                                                      | method (matches `message.type`)           |
| `@Retry({ attempts, backoff?, delay?, maxDelay? })`                      | method                                    |
| `@OnError()`                                                             | method`(error, message) => void \| 'ack'` |
| `@Message(schema?)` `@Headers(name?)` `@Ctx()`                           | param                                     |

### `@znight/config`

| Decorator                      | Target                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| `@Config(prefix?)`             | class (singleton provider)                                 |
| `@Env(name)` / `@Secret(name)` | property (`@Secret` masks the value in logs/serialisation) |
| `@Default(value)`              | property (a literal initializer also works)                |
| `@Key(path)`                   | property (file sources key, default `<prefix>.<property>`) |

### `@znight/observability` (interceptor decorators, declared in the manifest, §7)

`@Logged(opts?)` → `LoggedInterceptor`, `@Traced(opts?)` → `TracedInterceptor`,
`@Metric(opts?)` → `MetricInterceptor`.

## 6. Compiler

### 6.1 Pipeline

```
scan (include/exclude + provider libraries) → parse (oxc, cached by content hash)
→ per-file facts (imports, exports, declarations; cached) → resolve identities (global)
→ analyse classes (core + extensions) → bind (§4.7) → validate (§4.8)
→ emit (literal emitter, import routes) → re-parse check → write if content changed
```

Only parsing and per-file facts are cached. Everything from resolution onward is recomputed
globally on each compile (cheap). Compiles are serialised and debounced (~50 ms).

### 6.2 Public API

```ts
export function znight(options?: ZnightOptions): Plugin // Vite plugin (also default export)
export function compile(options?: ZnightOptions): Promise<CompileResult> // pure: reads sources only
export function generate(options?: ZnightOptions & { check?: boolean }): Promise<CompileResult>
export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  options?: { color?: boolean; cwd?: string },
): string
// '@znight/compiler/bun': Bun plugin/preload regenerating before tests and `bun --watch`

interface ZnightOptions {
  root?: string // default: Vite root / process.cwd()
  include?: string[] // default ['src/**/*.{ts,tsx,mts}']
  exclude?: string[] // default ['**/*.{test,spec}.*', '**/*.d.ts', '**/.znight/**']
  outFile?: string // default 'src/.znight/container.generated.ts'
  tsconfig?: string | false
  conditions?: string[] // extra scan conditions
  importExtension?: 'js' | 'ts' | 'none' // default 'js'
  sourceLocations?: 'dev' | 'always' | false
  stripDecorators?: boolean // default true
  extensions?: CompilerExtension[]
  trustedExtensions?: string[] // third-party packages allowed to provide extensions
  externals?: string[] // identities provided at runtime by custom plugins
  libraries?: string[] // packages to analyse from source (provider libraries)
  library?: boolean // library mode: emit dist/znight.providers.json
  strictValidation?: boolean
  reportUnused?: boolean
  prune?: boolean // drop unreachable providers
  app?: false | { entry?: string } // Vite build defaults for a server app (entry 'src/main.ts')
}
interface CompileResult {
  code: string
  outFile: string
  diagnostics: Diagnostic[]
  graph: ApplicationGraph
  stats: { files: number; providers: number; durationMs: number }
}
interface Diagnostic {
  code: ErrorCode
  severity: 'error' | 'warning'
  message: string
  location?: { file; line; column }
  hints?: string[]
  related?: { message; location }[]
}
```

`formatDiagnostics` prints code frames (picocolors) like:

```
✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService
  --> src/notification/notification.service.ts:12:5
   |
12 |     private readonly email: EmailService,
   |                             ^^^^^^^^^^^^
   = hint: Add @Injectable() to EmailService (src/email/email.service.ts:3)
```

### 6.3 Vite plugin

- Applies to the server/SSR environment only (`applyToEnvironment`); one compile per process is
  shared across environments.
- `config`: when `app !== false` and the user configured neither `build.ssr` nor `build.lib`:
  `build.ssr = entry`, `build.outDir = 'dist'`, `build.target = 'node24'`, `build.sourcemap = true`,
  `ssr.target = 'node'`.
- `buildStart`: compile. In `build`: errors fail the build and nothing is written. In watch/serve:
  diagnostics are printed and, if there are errors, the generated module is replaced by one that
  throws a `ZnightError` with the formatted diagnostics when imported.
- `resolveId`/`load`: the outFile id is served from memory (latest result); the disk copy exists for
  `tsc` and editors and is written only when its content changed. The outFile is ignored by watchers.
- Watching: include roots and every analysed file are watched (`addWatchFile`, server watcher);
  file create/unlink re-runs the glob; config files clear the resolver cache.
- `transform` (`enforce: 'pre'`): strips exactly the decorator ranges recorded by the last analysis
  of that file content (never re-decides); files not analysed are untouched. High-resolution source
  maps via `magic-string`.

### 6.4 Provider libraries

- **Source libraries**: packages listed in `libraries`, or whose manifest has `"znight": { "library": "source" }`,
  are scanned from their sources when they resolve to TypeScript with the scan conditions. Their
  providers get package identities and package import routes, so dev and prod agree.
- **Compiled libraries** (`library: true`): the compiler emits `dist/znight.providers.json`
  (`schemaVersion`, providers with identity, import route, scope, name/primary, heritage closure,
  injection points as type identities + flags, interceptor bindings, extension data with value refs
  as package exports). Referenced by `"znight": { "providers": "./dist/znight.providers.json" }`;
  the application compiler merges them before binding and validates their dependencies.

### 6.5 Compiler extensions

```ts
interface CompilerExtension {
  apiVersion: 1
  name: string // key in metadata.extensions (unique)
  decorators: Record<string, DecoratorSpec> // canonical identity -> { targets, params: ('static' | 'value')[] }
  analyzeClass?(cls: ClassInfo, ctx: AnalyzeContext): void
  validate?(ctx: ValidateContext): void
  generate?(ctx: GenerateContext): GenNode | undefined
}
```

- Loading: built-in core analysis + extensions of `@znight/*` packages referenced through
  `package.json#znight.compiler`, resolved with runtime conditions (with the source condition only
  when running under Bun). Third-party packages need `trustedExtensions` (otherwise a warning).
  Duplicate names from different paths/versions → ZNIGHT018.
- `ClassInfo`: name, identity, file, location, exported/import route, abstract, type parameters,
  decorators (`{ identity, name, args: ArgInfo[], location }`), constructor params (resolved through
  inheritance), methods (name, visibility, static, async, decorators, params, return type), properties
  (name, decorators, type, optional, initializer value), heritage closure.
- `ArgInfo`: `{ value?: StaticValue; ref?: ValueRef; location; text }`.
- `AnalyzeContext`: `registerProvider(cls, { scope?, factory? })`, `bindInjection(...)` /
  `resolveClassRef(arg)` (bind guards etc. to provider tokens, auto-registering injectable helper
  classes), `report(diagnostic)`, `store(data)`.
- `GenerateContext`: `importValue(ref)`, `importType(ref)`, `importFrom(module, name)`,
  `tokenOf(identity)`, and builders for `GenNode` (`obj`, `arr`, `lit`, `ref`, `call`, `arrow`,
  `code\`` tagged template that escapes every interpolation). Raw strings are never accepted.

## 7. Package manifest (`package.json#znight`)

```jsonc
"znight": {
  "apiVersion": 1,
  "compiler": "@znight/http/compiler",          // module exporting a CompilerExtension (or an array)
  "provides": [                                  // externals: types provided at runtime by a plugin
    { "export": "Logger", "plugin": "ObservabilityPlugin", "scope": "singleton" },
    { "export": "HttpContext", "plugin": "HttpPlugin", "scope": "request" }
  ],
  "interceptors": [{ "decorator": "Logged", "interceptor": "LoggedInterceptor" }],
  "library": "source",                           // optional: provider library analysed from source
  "providers": "./dist/znight.providers.json"    // optional: compiled provider library
}
```

Export names refer to the package's public entry; tokens are `<package>#<export>`.

## 8. Core runtime (`@znight/core`)

### 8.1 Container

```ts
class Container {
  static create(metadata: ZnightMetadata): Container // checks metadata.version (ZNIGHT018)
  register(token, definition): void // runtime definition (may depend on compiled tokens)
  registerValue(token, value): void
  override(tokenOrClass, valueOrDefinition): void // resolves aliases first
  init(options?: { only?: Token[] }): Promise<void>
  get<T>(tokenOrClass): T
  getOptional<T>(tokenOrClass): T | undefined
  has(tokenOrClass): boolean
  tokenOf(classRef): Token | undefined
  runInScope<R>(fn: () => R | Promise<R>, values?: Iterable<[Token, unknown]>): Promise<R>
  currentScope(): ScopeContext | undefined // .get(token) / .set(token, value)
  dispose(): Promise<void>
}
```

- **Precedence**: `override` > plugin `register`/`registerValue` > `Application.create({ providers })`
  > compiled. `registerValue` on a compiled token throws unless overridden; on an overridden token
  it is ignored. Any registration after `init()` → ZNIGHT016.
- **Init**: a runtime topological sort merges `resolutionOrder` with runtime definitions. Each
  singleton factory starts as soon as its dependencies settle (independent async singletons run
  concurrently). `only` instantiates the dependency closure of the given tokens. Missing externals
  are reported together (ZNIGHT001 naming `providedBy`). Factory errors are wrapped in ZNIGHT015
  (token, dependency path, source, `cause`). On failure, already created instances are disposed in
  reverse creation order, then the error is rethrown (cleanup errors attached).
- **Interceptors** (`definition.interceptors`) are applied by the container right after the factory,
  for every scope.
- **Request scope**: `runInScope` opens a scope (AsyncLocalStorage) seeded with token-keyed values;
  request-scoped providers and request-scoped externals are resolved from it (ZNIGHT013 when
  absent); instances created in the scope are disposed in reverse creation order when `fn` settles.
- **Lifecycle** is duck-typed on instantiated singletons (compiled providers and `@Provides`
  values): `onStart`, `onReady`, `onStop`, then disposal (`dispose` method name,
  `Symbol.asyncDispose`, `Symbol.dispose`). Transient instances belong to their consumer.
- Lookups use `Map`s / `Object.hasOwn`, never plain-object indexing with user tokens.

Additional API (implemented): `provide(token, value)` (application-level precedence),
`registerExternal(token, { scope })` (a plugin declaring e.g. a request-scoped external),
`instances()` (created singletons in resolution order with idempotent `dispose()`), `metadata`.
Two registrations at the same precedence level (plugin vs plugin) → ZNIGHT004 naming the first
registrant. Built-in externals (`CoreTokens`): `@znight/core#Container`, `@znight/core#Application`,
`@znight/core#Hooks`, `@znight/core#CoreLogger` — declared in `@znight/core`'s manifest so user
providers can inject them. `get(Class)` falls back to the class name for abstract bases behind
aliases. Cleanup errors are attached to the original error (`getSuppressedErrors(error)`);
aggregated errors are `ZnightAggregateError` (a `ZnightError` with `.errors`).

### 8.2 Application & plugins

```ts
const app = await Application.create({ metadata, plugins: [HttpPlugin.configure({ port: 3000 })] })
await app.start()
```

Options: `{ metadata, plugins?, providers?: Iterable<[Token | Class, unknown]> | Record<Token, unknown>,
overrides?, logger?, shutdown?: { signals?: NodeJS.Signals[] | false; timeoutMs?: number; hookTimeoutMs?: number } }`.

```ts
interface Plugin {
  readonly name: string
  register?(ctx: PluginContext): void | Promise<void> // provide externals (values or definitions)
  onBootstrap?(ctx: PluginContext): void | Promise<void> // after container.init (routes, consumers...)
  onStart?(ctx: PluginContext): void | Promise<void> // start ingress (listen, subscribe)
  onReady?(ctx: PluginContext): void | Promise<void>
  onStop?(ctx: PluginContext): void | Promise<void> // stop ingress and drain in-flight work
  onDispose?(ctx: PluginContext): void | Promise<void> // release infrastructure (connections, flush)
}
interface PluginContext {
  readonly app: Application
  readonly container: Container
  readonly metadata: ZnightMetadata
  readonly hooks: Hooks
  readonly logger: CoreLogger // live delegating reference (replaced by observability)
  getPlugin<P extends Plugin>(name: string): P | undefined
}
```

Plugin options MAY be a function of the container (`HttpPlugin.configure(c => ({ port: c.get(AppConfig).port }))`),
evaluated in `onBootstrap`.

Sequence:
1. `create()`: container ← metadata; `providers`; plugins `register` (in order); `overrides`;
   `container.init()`; plugins `onBootstrap`. Failure → transactional rollback.
2. `start()`: providers `onStart` (resolution order) → plugins `onStart` → providers `onReady` →
   plugins `onReady`; signal handlers installed (default `SIGINT`, `SIGTERM`). `state = 'ready'`.
   A failure stops what was started, disposes, and rethrows.
3. `stop()` (idempotent; waits for an in-progress `start()`): `state = 'stopping'` → plugins
   `onStop` (reverse) → providers `onStop` + disposal (reverse resolution order) → plugins
   `onDispose` (reverse) → `state = 'stopped'`. Every step is attempted with a per-hook timeout
   inside a global deadline (default 10 s); errors are aggregated (`AggregateError`, ZNIGHT021).
   Signal listeners are removed. Only the signal path sets `process.exitCode` (1 on failure) and a
   second signal forces exit (130). `import.meta.hot?.dispose(() => app.stop())` when available.
   `app.state`: `'created' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'`.
   Implementation notes: signal handlers are installed when `start()` begins (Ctrl+C during a slow
   boot shuts down gracefully); only providers whose `onStart` ran receive `onStop` (disposal always
   runs); `hookTimeoutMs` defaults to 5 s; HMR: pass `hot: import.meta.hot`; tests can inject
   `shutdown.process`. `hooks.run()` resolves with `fn`'s result.

### 8.3 Hooks

```ts
interface ZnightHooks {} // augmented: 'http:request', 'messaging:message', ...
class Hooks {
  on<K>(name: K, listener): () => void
  emit<K>(name: K, event): void
  wrap<K>(name: K, wrapper: (event, next: () => Promise<unknown>) => Promise<unknown>): () => void
  run<K, R>(name: K, event, fn: () => Promise<R>): Promise<R> // first registered = outermost
}
```

### 8.4 AOP

```ts
interface MethodInterceptor<O = unknown> {
  intercept(invocation: MethodInvocation, options: O): unknown
}
interface MethodInvocation {
  readonly target: object
  readonly className: string
  readonly methodName: string
  readonly args: readonly unknown[]
  readonly isAsync: boolean
  proceed(args?: readonly unknown[]): unknown
}
```

Interceptors are applied as own-property wrappers on the instance (no Proxy): `#private` fields
keep working and self-invocation (`this.method()`) is intercepted. The top-most decorator is the
outermost interceptor. In development, an interceptor returning a thenable for a sync method throws
a `ZnightError` naming the interceptor.

### 8.5 Errors

`ZnightError extends Error { code; hints }`. Catalogue: `ErrorCode` (`as const`) + `ERROR_DESCRIPTIONS`.

## 9. Feature runtime contracts

### 9.1 HTTP (`@znight/http`)

```ts
interface HttpMetadata {
  controllers: HttpControllerDefinition[]
}
interface HttpControllerDefinition {
  token
  basePath
  guards: Token[]
  interceptors: Token[]
  meta: Record<string, unknown>
  routes: HttpRouteDefinition[]
}
interface HttpRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ALL'
  path: string
  fullPath: string
  handler: string
  status?: number
  headers?: Record<string, string>
  meta: Record<string, unknown>
  guards: Token[]
  interceptors: Token[]
  params: {
    index
    source: 'param' | 'query' | 'body' | 'headers' | 'request' | 'response' | 'context'
    name?
    type?
    optional?
    schema?: boolean
  }[]
  rawResponse?: boolean
  invoke: (controller: any, ctx: HttpContext) => unknown
}
```

Pipeline (normative), per request:
`container.runInScope({ HttpContext, RequestId }) → hooks.run('http:request', event, () =>
global guards → controller guards → route guards → global/controller/route interceptors →
invoke (extract → coerce → validate → handler) → serialise)`. Exceptions are mapped to a response
inside `hooks.run` and `event.status` / `event.error` are set before it resolves.

- Path grammar: static segments, `:name` params, trailing `*` wildcard; anything else ZNIGHT007.
  Translated per adapter. Trailing-slash policy option (default strict) applied on every adapter.
  The Fastify adapter disables `exposeHeadRoutes`; Znight serves HEAD for GET routes.
- Query parsing is done by Znight from the URL (`Record<string, string | string[]>`); coercion to
  `T[]` accepts a single value.
- Status precedence: `@HttpCode` > `HttpResponse.status` > default (201 for POST, 200 otherwise);
  `undefined` return → empty body (204 unless POST or `@HttpCode`). Objects → JSON, strings → text,
  `Uint8Array`/`ReadableStream` → octet-stream, Web `Response` → sent as is.
- Errors: `HttpException(status, message, details?)` and subclasses render `{ statusCode, error,
  message, details? }`; schema failures → 400 with `details: [{ path, message }]`; other errors →
  `{ statusCode: 500, error: 'Internal Server Error' }` (message only with `exposeErrors: true`),
  sent to hooks and the logger.
- Handlers receive the schema **output** (defaults, transforms, stripped keys).
- `HttpPlugin.configure({ adapter, port, host, prefix, guards, interceptors, exceptionMappers,
  trailingSlash, exposeErrors, bodyLimit })`; class refs are resolved with `container.tokenOf`.
- `HttpAdapter { name; registerRoute(route); listen(port, host); close(); inject(request) }`;
  `inject` is in-memory (fastify `inject`, hono `request`, express via `light-my-request`, an
  optional peer).
- Request-scoped externals: `HttpContext` (and `RequestId`) are provided per request.

### 9.2 Messaging (`@znight/messaging`)

```ts
interface MessagingMetadata {
  consumers: ConsumerDefinition[]
}
interface ConsumerDefinition {
  token
  queue
  options?: Record<string, unknown>
  handlers: MessageHandlerDefinition[]
  errorHandler?: string
}
interface MessageHandlerDefinition {
  method: string
  type?: string
  retry?: { attempts: number; backoff: 'fixed' | 'exponential'; delay: number; maxDelay?: number }
  invoke: (consumer: any, message: InboundMessage) => unknown
}
```

Delivery state machine (at-least-once; handlers must be idempotent):
- each delivery runs in its own scope (`InboundMessage` request-scoped external) through
  `hooks.run('messaging:message')`;
- handler selected by `message.type` (header/routing key, per driver); handler without type is the
  default; no match → dead-letter with reason;
- success → ack; `NonRetryableError` or schema failure → dead-letter immediately;
- retryable failure → retry: attempt count from the broker (SQS `ApproximateReceiveCount`, RabbitMQ
  `x-delivery-count`) or an `x-znight-attempt` header; delay in-process only within the driver's
  `maxInProcessDelayMs` budget, otherwise driver-native delayed redelivery (SQS visibility, RabbitMQ
  TTL + DLX retry queue, Kafka retry topic); boot fails if `@Retry` cannot be honoured;
- after the last attempt `@OnError` runs: returning `'ack'` swallows the message, otherwise (or on
  throw) dead-letter. DLQ publish uses confirms; the original is acked only afterwards, else
  nacked/requeued. Native DLQ configuration is verified at subscribe time;
- `concurrency` per consumer; on stop, in-flight handlers are awaited and pending retries are
  nacked/requeued, never dropped.
  `MessagingDriver { name; capabilities: { nativeDelay; maxInProcessDelayMs; deliveryCount }; connect();
subscribe(queue, handler, options); publish(queue, message); close() }`. `MessageBroker` (external)
  exposes `publish(queue, payload, { type, headers, key })`.

### 9.3 Config (`@znight/config`)

```ts
interface ConfigMetadata {
  configs: { token; prefix?; fields: ConfigFieldDefinition[] }[]
}
interface ConfigFieldDefinition {
  property: string
  env: string
  key: string
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'url' | 'json'
  enum?: (string | number | boolean)[]
  default?: unknown
  required: boolean
  secret: boolean
}
```

Config classes are singleton providers generated with factory `loadConfig(Class, source, fields)`.
`ConfigPlugin.configure({ loaders })` builds a `ConfigSource` (external) from loaders (env, `.env`
files via `node:util` `parseEnv`, JSON/YAML files, Vault, AWS Secrets Manager); `register()`
validates every config class at once and throws ZNIGHT006 listing all missing values.

### 9.4 Observability (`@znight/observability`)

`ObservabilityPlugin.configure({ logging?, metrics?, tracing? })` registers `Logger`,
`MetricsRegistry`, `Tracer`, `LoggedInterceptor`, `TracedInterceptor`, `MetricInterceptor` and
wraps `http:request` / `messaging:message` (request logs, RED metrics, spans with W3C
trace-context). `Logger` is pino-based and adds `requestId`/`traceId`/`spanId` from the current
scope; it is flushed in `onDispose`.

## 10. Testing (`@znight/testing`)

```ts
const { instance, mocks } = await TestBed.create(UserService, { metadata })
mocks.get(DatabaseClient).findOne.mockResolvedValue(null)

const app = await TestApp.create({
  metadata,
  plugins: [HttpPlugin.configure({ adapter: fastify() })],
  overrides: [[UserRepository, fakeRepo]],
})
const res = await app.inject({ method: 'GET', url: '/users/1' })
```

- Metadata freshness: `@znight/compiler/bun` preload (and the Vite plugin under Vitest) regenerate
  before tests.
- TestBed builds the target with real code and mocks its direct dependencies by kind: classes /
  interfaces / externals → auto-mocks (non-thenable: `then`, `toJSON`, `Symbol.toPrimitive`,
  `asymmetricMatch` are `undefined`; unconfigured methods return `undefined`), config classes → real
  instances from defaults + `config` overrides, qualifiers/primitives → must be provided, optional →
  `undefined`, multi → `[]`, `Lazy<T>` → getter over the mock. Interceptor dependencies are neither
  mocked nor applied unless `aop: 'real'`. `mocks.get` accepts classes, tokens and display names.
- The spy implementation is pluggable (`mockFn`) and auto-detects Vitest (`vi.fn`), Jest
  (`jest.fn`) and `bun:test` (`mock`), falling back to a built-in Jest-compatible spy.
- `TestApp` disables signal handlers, applies `overrides` last and instantiates only the closure of
  controllers/consumers by default.

## 11. CLI (`@znight/cli`)

`znight new <name>` (templates: package manager, HTTP adapter), `znight generate [--check] [--watch]`,
`znight g service|controller|consumer|config|guard|interceptor <name>`, `znight dev` (Vite build in
watch mode, full process restart on every successful rebuild — no partial HMR of providers, no Vite
dev server), `znight build`, `znight start`. `vite` and `@znight/compiler` are peers.

## 12. Release

Changesets with a `fixed` group (lockstep versions). CI packs with `bun pm pack` (rewrites
`workspace:`/`catalog:`) and publishes the tarballs with `npm publish --provenance` (OIDC trusted
publishing). A smoke test installs the packed tarballs into a clean app and runs it on Node 24 and
Bun.
