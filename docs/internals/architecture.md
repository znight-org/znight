# Znight architecture

This document is the technical specification of Znight. It is the contract between the packages:
the compiler generates code that the runtime packages consume, so both sides MUST follow it. When
an implementation needs to deviate, update this document in the same change.

Normative words (MUST, SHOULD, MAY) are used in their RFC 2119 sense. Paragraphs marked
**Impl.** describe implementation-defined behaviour of the 0.1 implementation: users may observe
it and package READMEs document it, but other packages MUST NOT rely on it and it may change in a
minor release without changing the contract.

## 1. Principles

1. **Compile-time DI.** The compiler (`@znight/compiler`, a programmatic API + a Vite plugin and a
   Bun preload) parses the application with [oxc](https://oxc.rs), resolves every injection point
   to a concrete provider, validates the graph and generates a plain TypeScript module
   (`__ZNIGHT_METADATA__`). No `reflect-metadata`, no `emitDecoratorMetadata`, no runtime type
   lookup.
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
  core/           runtime: container, application, plugins, hooks, AOP, scopes, decorators, errors
  compiler/       programmatic API (+ Vite plugin, Bun preload): analysis, binding, validation, codegen
  http/           decorators, compiler extension, HttpPlugin, adapters (node, fastify, express, hono)
  messaging/      decorators, compiler extension, MessagingPlugin, drivers (memory, rabbitmq, sqs, kafka)
  config/         decorators, compiler extension, ConfigPlugin, loaders (env, dotenv, json, yaml, vault, aws, inline)
  observability/  Logger (pino), metrics (prom-client), tracing (OpenTelemetry), interceptors, ObservabilityPlugin
  openapi/        decorators, compiler extension, OpenApiPlugin, OpenAPI 3.1 assembly (buildOpenApiDocument),
                  emission (/emit, /vite: `znight openapi`), validateResponse (/testing) (RFC 0002)
  schedule/       decorators, compiler extension, SchedulePlugin, SchedulerRegistry, cron engine, lock
                  stores, test clock and lock store scenarios (/testing) (RFC 0004)
  testing/        TestBed (auto-mocking), TestApp (e2e), mocks and spies
  cli/            `znight` binary: new, generate, g, dev, build, start
examples/         runnable example applications: rest-api, microservice, worker, monorepo (services + a
                  source provider library); each has its own tests (`bun run test:examples`)
tests/            repository-wide tests: boundaries (§2), golden test of the examples (§4.1)
docs/             VitePress documentation site (this file is rendered under /contributing/)
rfcs/             design documents of significant changes, with their status and the error code allocation
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
- `isolatedDeclarations`: every exported function / class member has an explicit type;
- sources also type-check with `noPropertyAccessFromIndexSignature` (index-signature members are
  read with brackets: `process.env['NODE_ENV']`), so applications type-checking Znight through
  `@znight/source` with strict settings stay green.

A project type-checking the framework sources through the condition (`customConditions:
["@znight/source"]`: the examples, a monorepo developing against a checkout) also needs
`allowImportingTsExtensions` (hence `noEmit`), since those sources import each other with the `.ts`
suffix (TS5097 otherwise).

Each package has `tsconfig.json` (sources, strict library settings) and `test/tsconfig.json` (tests,
Bun types, decorators allowed). `typecheck` runs both.

### Package conventions

- `src/index.ts` is the public runtime entry. Additional entries (`src/compiler/index.ts`,
  `src/adapters/fastify.ts`...) are declared in `tsdown.config.ts` **and** `package.json#exports`
  with the same `@znight/source` / `types` / `default` triple.
- Tests: `packages/<pkg>/test/**/*.test.ts` with `bun:test`; fixtures in `test/fixtures/`.
  Broker integration tests run only with `ZNIGHT_INTEGRATION=1` (Docker, testcontainers), the CLI
  end-to-end test only with `ZNIGHT_CLI_E2E=1`, the end-to-end tests of the examples and the golden
  test only with `ZNIGHT_E2E=1` (after `bun run build`). Root scripts: `test` (packages, docs and
  `tests/`, from sources), `test:examples` (the `test` script of every example), `test:e2e` (build,
  then the examples, `tests/` and the CLI end-to-end test with their flags), `test:integration`.
- Third-party integrations (fastify, amqplib, pino...) are **optional peer dependencies** (plus exact
  devDependencies for tests) unless the package cannot work without them. Adapters and drivers live
  in subpath exports, so their clients are only loaded when used; optional peers needed by a root
  entry (`yaml`, the AWS SDK, `prom-client`, `pino-pretty`) are loaded lazily (non-literal dynamic
  import, or `createRequire` for CommonJS peers), so bundlers never require an absent peer.
  Third-party `dependencies`/`peerDependencies` use caret ranges; `@znight/core` is a
  `workspace:*` dependency (an exact version once packed: lockstep) and the optional
  `@znight/compiler` peer a `workspace:^` range.
- Boundaries (enforced by the packages' own tests and, for every package, by
  `tests/boundaries.test.ts`, which follows the value imports of each `package.json#exports` entry):
  - `<pkg>/compiler` entries only `import type` from `@znight/compiler` and never import the
    package's runtime entry (so building never loads fastify, amqplib...). Code they share with the
    runtime lives in import-free modules (`@znight/config` `conventions.ts`/`coerce.ts`;
    `@znight/http` `path.ts`, `mime.ts`, `size.ts`; `@znight/openapi` `shared.ts`, the grammars of
    operation ids, header names and media types; `@znight/schedule` `cron/*` (parser, fields, time
    zones, never-fires analysis: one cron engine for the build and the process), `duration.ts` and
    `names.ts`) or is duplicated in one and kept equal by a test (`@znight/messaging` retry
    constants). Other import-free runtime modules (`@znight/http` `cookies.ts`, `sse-parse.ts`) are
    safe to import anywhere;
  - runtime entries never import `./compiler`;
  - `@znight/compiler` is at most an optional peer of feature packages and of the CLI.

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
accepts a display name when it is unique, and throws ZNIGHT008 listing the candidates otherwise. The
public API is class-first: `container.get(UserService)`.

### 3.2 Shape

```ts
interface ZnightMetadata {
  version: 1 // metadata format, checked by Container.create
  compiler?: string // @znight/compiler version that produced it
  providers: Record<Token, ProviderDefinition>
  resolutionOrder: Token[] // topological (dependencies first), deterministic
  aliases?: Record<Token, Token> // provided-type identity / interface / base class -> provider token
  externals?: ExternalDefinition[] // tokens supplied at runtime by plugins
  extensions?: ZnightExtensionsMetadata // { http?, messaging?, config? }, augmented by each package
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
  scope?: Scope // default singleton
  providedBy?: string // plugin name, used in messages
  optional?: boolean
}
```

`Lazy<T>` (`{ lazy: Token }`) injects `{ get(): T }`, resolved at call time in the current scope.
It is the escape hatch for ZNIGHT002 (cycles) and ZNIGHT003 (a singleton needing a request-scoped
value).

### 3.3 Generated module

`src/.znight/container.generated.ts` (option `outFile`). Example (real output, `build` mode, an
application using `@znight/config`, `@znight/http` and `@Logged` from `@znight/observability`):

```ts
// AUTO-GENERATED by @znight/compiler 0.1.0. Do not edit.
// biome-ignore-all lint: generated file
/* eslint-disable */
import type { ZnightMetadata } from '@znight/core'
import type { ConfigFieldDefinition } from '@znight/config'
import { loadConfig } from '@znight/config'
import type { HttpContext } from '@znight/http'
import { coerce } from '@znight/http'
import { AppConfig } from '../app.config.js'
import { UserController } from '../users/user.controller.js'
import { UserService } from '../users/user.service.js'

const AppConfig$fields: readonly ConfigFieldDefinition[] = [
  {
    ['property']: 'port',
    ['env']: 'PORT',
    ['key']: 'app.port',
    ['type']: 'number',
    ['default']: 3000,
    ['required']: false,
    ['secret']: false,
  },
  {
    ['property']: 'apiKey',
    ['env']: 'API_KEY',
    ['key']: 'app.apiKey',
    ['type']: 'string',
    ['required']: false,
    ['secret']: true,
  },
]

export const __ZNIGHT_METADATA__: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {
    ['src/app.config.ts#AppConfig']: {
      scope: 'singleton',
      class: AppConfig,
      deps: [{ token: '@znight/config#ConfigSource', optional: true }],
      factory: d => loadConfig(AppConfig, d[0], AppConfig$fields),
    },
    ['src/users/user.controller.ts#UserController']: {
      scope: 'singleton',
      class: UserController,
      deps: ['src/users/user.service.ts#UserService'],
      factory: d => new UserController(d[0]),
    },
    ['src/users/user.service.ts#UserService']: {
      scope: 'singleton',
      class: UserService,
      deps: ['@znight/observability#Logger', 'src/app.config.ts#AppConfig', '@znight/observability#LoggedInterceptor'],
      factory: d => new UserService(d[0], d[1]),
      interceptors: { ['findById']: { async: true, chain: [{ dep: 2, options: { ['level']: 'debug' } }] } },
    },
  },
  resolutionOrder: [
    'src/app.config.ts#AppConfig',
    'src/users/user.service.ts#UserService',
    'src/users/user.controller.ts#UserController',
  ],
  externals: [
    { token: '@znight/config#ConfigSource', providedBy: 'ConfigPlugin' },
    { token: '@znight/observability#LoggedInterceptor', providedBy: 'ObservabilityPlugin' },
    { token: '@znight/observability#Logger', providedBy: 'ObservabilityPlugin' },
  ],
  extensions: {
    ['config']: {
      ['configs']: [{ ['token']: 'src/app.config.ts#AppConfig', ['prefix']: 'app', ['fields']: AppConfig$fields }],
    },
    ['http']: {
      ['controllers']: [
        {
          ['token']: 'src/users/user.controller.ts#UserController',
          ['basePath']: '/users',
          ['guards']: [],
          ['interceptors']: [],
          ['meta']: {},
          ['routes']: [
            {
              ['method']: 'GET',
              ['path']: '/:id',
              ['fullPath']: '/users/:id',
              ['handler']: 'getUser',
              ['meta']: {},
              ['guards']: [],
              ['interceptors']: [],
              ['params']: [{ ['index']: 0, ['source']: 'param', ['name']: 'id', ['type']: 'number' }],
              ['invoke']: (c: UserController, ctx: HttpContext) =>
                c.getUser(coerce.number(ctx.params['id'], 'param "id"')),
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

- **Deterministic**: no timestamps; output order derived from canonical identities only. A full
  compile and any sequence of incremental compiles produce byte-identical output, and output is
  identical with or without the `@znight/source` condition and on every OS.
- **Layout**: the three header lines, the imports, the module-level constants, then
  `export const __ZNIGHT_METADATA__: ZnightMetadata = {...}` and `export default __ZNIGHT_METADATA__`.
- **Keys**: the fixed keys of the metadata format (`version`, `providers`, `scope`, `deps`,
  `factory`, `chain`...) are bare identifiers. Every key that comes from data — tokens, alias keys,
  method names in `interceptors`, extension names and every key of an extension section or of a
  literal value — is a computed, single-quoted string key (`['findById']`), so `__proto__` stays an
  own property. Values are produced by a single literal emitter (handles `undefined`, `NaN`,
  `±Infinity`, `-0`, bigint, `RegExp`, `Date`, nested objects/arrays; rejects functions, symbols,
  class instances and cycles). Extensions never splice raw strings (§6.5).
- **Imports** use **import routes** (§4.2), grouped and sorted: `@znight/core` first, then the other
  bare specifiers, then relative paths; for one specifier `import type` comes before the value
  import, and a type and a value import of the same binding are merged. Only imports and constants
  reachable from the emitted metadata are printed. Identifiers are validated and de-duplicated by
  identity order (`UserService`, `UserService$1`); they never shadow a global (`Date$1`) nor an arrow
  parameter.
- **Constants**: `GenerateContext.constant(name, value, { type })` (§6.5) declares a module-level
  `const <name>: <type> = <value>` printed before `__ZNIGHT_METADATA__`, in declaration order,
  de-duplicated like imports (`AppConfig$fields`, `AppConfig$fields$1`). `@znight/config` uses it
  for `<Class>$fields`, shared by the factory and the `config` section.
- **Omissions**: absent optional fields are omitted, never `undefined` (`exactOptionalPropertyTypes`):
  empty `aliases`/`externals`/`extensions`, an extension whose `generate` returns `undefined`,
  unset provider fields (`async`, `interceptors`, `dispose`, `name`, `primary`, `source`), an
  external's `scope` when it is `singleton`.
- **Factories**: `() => new X()` without dependencies, `d => new X(d[0], d[1])` for a class,
  `d => d[0].method(d[1])` for `@Provides` (`deps[0]` is the `@Factory` instance), or the node
  returned by an extension's custom factory. Interceptor dependencies are appended after the factory
  arguments; `chain[].dep` indexes `deps`.
- The code MUST type-check under strict user settings (`strict`, `noUnusedLocals`,
  `noUnusedParameters`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`): index access uses brackets, unused arrow parameters are omitted
  (`(c: RootController) => c.index()`), `invoke` keeps typed parameters so handler signatures are
  type-checked.
- After assembly the compiler re-parses the module with oxc; a syntax error is a compiler bug
  reported (ZNIGHT018) with the name of the extension that produced the faulty section.
- `source` locations are emitted in `serve`/`test`, omitted in `build` (option `sourceLocations:
  'dev' | 'always' | false`). This applies to the module served from memory (the bundle): the disk
  copy is the `serve` rendering in every mode (`CompileResult.diskCode`, §6.2), so `znight
  generate`, `vite build`, the Bun preload and `--check` agree on one file. `source.file` is
  relative to the project root for application files and `<package>/<path in the package>` for
  package files (independent of symlinks and of the `node_modules` layout).
- **Error module**: when the compilation has errors, the module served instead
  (`renderErrorModule`, §6.2) keeps the header and a typed `__ZNIGHT_METADATA__` export (importers
  keep linking and type-checking) but throws a `ZnightError` carrying the formatted diagnostics
  when imported. It is never written to disk by `generate()`.
- **Impl.** formatting: a Prettier-like printer (120 columns, single quotes, no semicolons,
  trailing commas).
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

Golden test: compiling a fixture library from its sources and from its `dist` (with and without
`@znight/source`) yields identical identities, types, import routes and generated output.
`tests/golden.test.ts` (`ZNIGHT_E2E=1`, after `bun run build`) applies it to every example
application: each is compiled in a child process with the compiler, its extensions and the analysed
declarations taken from the sources (`--conditions=@znight/source` and the scan condition) and from
`dist`, on Node.js and on Bun, in `build` and `serve` modes; every generated module MUST be
byte-identical.

### 4.2 Import routes

Every value the generated module needs (provider classes, schemas, guards, helpers) has an import
route `(specifier, exportName | 'default', members?)`:

- application file: relative path from `outFile`, extension mapped (`.ts`/`.tsx` → `.js`, `.mts` →
  `.mjs`, `.cts` → `.cjs`; option `importExtension: 'js' | 'ts' | 'none'`), exported name actually
  exported by the **declaring** module (alias-aware: `export { Impl as UserService }`, `export
default` → default import);
- package declaration: bare specifier of the public entry + public export name, checked against the
  runtime conditions. Never a path into another package.
- Routes always point to the declaring module (an ESM barrel can only re-export what the declaring
  module exports), which also limits import cycles (ZNIGHT020). CommonJS packages (`export =`,
  untyped) are imported through `default` plus a member path.
- A provider or referenced value that is not exported (or an anonymous default export) is
  ZNIGHT005 with the fix-it "export it". A provider class exported as a type only (`export type {
  X }`) is ZNIGHT005 too ("export it as a value"); when a module exports a binding both ways, the
  route uses a value export.

### 4.3 Resolution

oxc-resolver configured with: the nearest tsconfig of each importing file (`paths`), the Vite
`resolve.alias` (string aliases only) and `resolve.conditions` when running inside Vite,
`extensionAlias` (`.js` → `.ts/.tsx/.js`, `.mjs` → `.mts/.mjs`, `.cjs` → `.cts/.cjs`; in scan mode
also to `.d.ts`/`.d.mts`/`.d.cts`), and two condition sets: **scan conditions** (`conditions` option
\+ `types, import, node, default`; may include `@znight/source`, used to find sources to analyse)
and **runtime conditions** (default `node, import, default`; used for import routes and loading
extensions). A bare specifier resolving to JavaScript falls back to its `@types` package. The
resolver cache is cleared on file create/unlink/rename and on any
`package.json`/`tsconfig*.json`/lockfile change.

### 4.4 Types

`TypeInfo` = `primitive` (`string|number|boolean|bigint|symbol|null|undefined|void|any|unknown|never|object`)
| `literal` | `reference { identity, name, typeArgs }` | `array { element }` | `tuple` | `union` |
`intersection` | `promise { inner }` | `typeParameter` | `opaque { text, reason }`.

Normative serialization (used inside identities and to compare types):

- primitives by keyword, literals as JSON; `Array<T>`, `ReadonlyArray<T>`, `readonly T[]` → `T[]`;
- unions/intersections flattened, de-duplicated and sorted by serialization; `true | false` →
  `boolean`, literals absorbed by their primitive, `never` dropped, `any`/`unknown` absorb the rest;
- default type arguments filled from the declaration; generic aliases expanded with substitution
  (`type UserRepo = Repository<User>`), heritage clauses through an alias included (`implements
  UserRepo` counts for the closure of `Repository<User>`, transitively); recursive aliases are
  opaque. An alias supplied at runtime (declared in a manifest `provides` or in `externals`, e.g.
  the branded string `@znight/http#RequestId`) is expanded everywhere (what extensions see in
  `ParameterInfo.type`, coercion included) except at unqualified injection points (§4.7 step 5);
- object literal types, function types, mapped/conditional types, `typeof`, `import()` types are
  opaque. Opaque in an injection type → ZNIGHT010 (unless qualified, §4.7).

### 4.5 Class analysis

- **Constructor**: the nearest class in the `extends` chain declaring a constructor (resolved
  through imports and identities); type parameters substituted with heritage type arguments; that
  declaration's parameter decorators apply. If the chain hits something unanalysable (call
  expression `extends Mixin(Base)`, a package class without parseable declaration) → ZNIGHT010
  "declare an explicit constructor". TypeScript `this` parameters are ignored.
- **Heritage closure**: all `extends`/`implements` identities with substituted type arguments,
  transitively (classes and interfaces).
- **Lifecycle**: `onStart`/`onReady`/`onStop` (and `[Symbol.asyncDispose]`/`[Symbol.dispose]`) found on
  the class or its analysable bases. Used for ZNIGHT009 only; the runtime duck-types instances.
- **Interceptors** are collected from the class and its analysable bases; the most derived
  declaration of a method wins (an override without decorators removes the base interceptors).
- `@Injectable` on a class with unbound type parameters → ZNIGHT005 ("subclass with concrete type
  arguments or use @Provides").
- Not analysed (**Impl.** limitation): classes inside namespaces, class expressions, nested classes.

### 4.6 Decorators and static evaluation

A decorator is recognised by the canonical identity of its callee (resolved like types: renamed
imports, barrels, `export *`, namespace imports `@zn.Get()`). Compiler extensions declare the
identities they own (e.g. `@znight/http#Get`). A local function whose body calls a Znight
decorator gets a ZNIGHT005 warning ("composite decorators are not visible to the compiler"). So
does a `const` alias of a Znight decorator (`export const Service = Injectable`, also through `as`,
`satisfies`, `!`, parentheses and chains of `const` aliases, in any file): the alias is **not
followed** (the decorator is ignored) and the hint suggests a re-export
(`export { Injectable as Service } from '@znight/core'`), which is followed.

Each decorator parameter is declared **static** (paths, names, scopes, queue names, env names,
`@Default` values, retry options: MUST evaluate) or **value** (schemas, guards, interceptor
options: evaluated when possible, otherwise MUST be a reference to an exported binding, imported by
the generated module).

The static evaluator accepts: literals (incl. unary `-`/`+`/`!`/`~`/`void`), binary arithmetic,
bitwise and comparison operators and string concatenation, `??`, `||`, `&&`, ternaries, template
literals with evaluable expressions, property/element access (incl. optional chaining) on evaluated
objects/arrays, `as const`, `satisfies`, parentheses, non-null assertions, spreads of evaluated
values, enum members, `declare const X: <literal type>`, and `const` references across files and
packages (cycle-guarded). Each evaluation records the files it read (for invalidation). Non-evaluable
static argument or inline non-evaluable value argument → ZNIGHT005 with the fix-it "extract to
`export const X = ...`".

### 4.7 Binding algorithm (normative)

For an injection point with type `T` (identity), optional qualifier `q` (`@Inject('q')`), flags
optional / multi / lazy:

1. `C = exact(T) ∪ assignable(T)` where _exact_ are providers whose **provided type** is `T`, and
   _assignable_ those whose heritage closure contains `T`.
2. With a qualifier: `C = C ∩ named(q)` (`@Named(q)` / `@Provides({ name: q })`).
3. Multi (`T[]`): all of `C`, ordered by token. Never fails.
4. Single: one exact candidate → bound; else the unique `@Primary` → bound; else if `C` has several
   candidates all providing the exact same type → ZNIGHT004, several otherwise → ZNIGHT008 (both
   reported at the injection point).
5. Empty `C`: package type declared in a manifest `provides` (§7) → external (never for a qualified
   injection). An unqualified injection point whose annotation is an alias supplied at runtime keeps
   the alias identity (it is not expanded, §4.4), so `requestId: RequestId` binds to the
   `@znight/http#RequestId` external, not to `string`. Optional (`?`, `| undefined`, `| null`, default
   value, `@Optional()`) → `{ token, optional: true }` (`undefined` injected) where the token is
   never a provider token nor an alias key: the type identity for an unqualified injection of a
   public, non-generic type (a plugin may register a value under it), the qualifier for a qualified
   injection (or a primitive), otherwise the display of the type (`Repository<User>`, independent of
   the package layout); else ZNIGHT001.
6. Primitive/opaque types require a qualifier; providers are matched by `(qualifier, type kind)`.
   A qualifier match providing a different kind → ZNIGHT010 (an opaque type is compatible with any
   kind).
7. `Lazy<T>` binds `T` with the same rules and emits `{ lazy: token }` (`{ token, optional: true }`
   when optional and unbound: `undefined` is injected).

`@Provides` return types drop `| undefined | null`. ZNIGHT001 includes a **near-miss analysis**:
classes with the same name but a different identity (both import paths shown), an undecorated class
of type `T`, a matching class excluded by `include`/`exclude`, a class with a matching name but no
`implements` clause, candidates removed by the qualifier. Messages show display names
(`Repository<User>`) plus `file:line`, never raw identity strings alone.

Aliases are emitted for every provided type / heritage identity that resolves to exactly one
provider (or one primary), so `container.get(UserRepository as never)` / `get('UserRepository')` work.
No alias is emitted for `globalThis#*`, the core marker types (`Lazy`, `OnStart`, `OnReady`,
`OnStop`, `MethodInterceptor`), externals (manifest `provides`, `externals` option, `CoreTokens`:
the container resolves registrations through aliases, so a plugin or the core would replace the
application provider, e.g. `class AppLogger implements CoreLogger`) nor package-internal identities
(`<package>/<relpath>#Name`: not nameable by user code, layout-dependent).

### 4.8 Validations

| Code      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Severity                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| ZNIGHT001 | Missing provider for a required dependency (a warning for library dependencies in library mode)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | error                                          |
| ZNIGHT002 | Circular dependency (over the full edge set except `Lazy` and extension edges, prints the cycle, hints at `Lazy<T>`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | error                                          |
| ZNIGHT003 | Scope mismatch: a singleton depends (directly, through transients, multi, guards, interceptors, extension edges or externals) on a request-scoped provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | error                                          |
| ZNIGHT004 | Duplicate provider for the exact same type without qualifier/`@Primary`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | error                                          |
| ZNIGHT005 | Invalid decorator usage (target, arguments, unexported reference, non-public/`#private`/static handler or `@Provides`, abstract or unbound generic provider, provider exported as a type only, class registered by several provider decorators, decorator applied twice, `@Provides` outside `@Factory` or without concrete return type, parameter decorator imported from another feature package; warnings: composite decorator, `const` alias of a decorator; route decorators: two decisions of one group on a target, definitions of a key or of a group that disagree on their options; `@Cookie` / `@SignedCookie`: invalid cookie name, nameless `@SignedCookie`; `@Sse`: invalid options, applied twice or with another route decorator, with `@HttpCode`, `@Header('content-type')` or `@Res()`, a primitive return type, warning for a request body; job decorators: method shape, abstract or generic host, a route that is also a job; at boot: invalid `cookies` (secrets shorter than 32 bytes, duplicates, unknown keys) and `sse` options) | error / warning                                |
| ZNIGHT006 | Missing or invalid required configuration value, failing config loader (runtime); a route reading `@SignedCookie` without `cookies.secrets` (boot)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | error                                          |
| ZNIGHT007 | Invalid route (path grammar, duplicate method+path, `:param` without `@Param` and vice versa, non-coercible param or cookie type; at boot: malformed metadata, `groups` and `sse` included, and invalid or colliding plugin routes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | error                                          |
| ZNIGHT008 | Ambiguous injection (several candidates for an interface / base type, ambiguous display name at runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | error                                          |
| ZNIGHT009 | Invalid lifecycle hook (required params, static; on a non-singleton → warning; dispose hooks or `@Provides({ dispose })` on a transient → warning)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | error / warning                                |
| ZNIGHT010 | Unresolvable injection type (missing/opaque annotation, primitive without qualifier, unresolvable import, unanalysable inherited constructor); import casing mismatch, unresolvable library (warnings)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | error / warning                                |
| ZNIGHT011 | Invalid message consumer (no handler, several default handlers, duplicate types, shadowed `*` patterns, invalid retry or consumer options, undecorated parameter, invalid `@OnError`, several consumer classes for one queue; at boot: a retry policy the driver cannot honour, invalid `MessagingPlugin` options)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | error                                          |
| ZNIGHT012 | Invalid config class (unsupported property type, config decorator outside `@Config`, duplicate env names or key paths, invalid name/key/prefix, `@Default` not matching the type, constructor with required parameters; invalid `ConfigPlugin` options or config metadata at runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | error                                          |
| ZNIGHT013 | Request-scoped provider resolved outside of a request scope (runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | error                                          |
| ZNIGHT014 | Async factory on a non-singleton provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | error                                          |
| ZNIGHT015 | Provider instantiation failed (runtime; carries dependency path, source, cause)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | error                                          |
| ZNIGHT016 | Container sealed: register/override after `init()` (runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | error                                          |
| ZNIGHT017 | Unvalidated input: non-primitive `@Body`/`@Query`/`@Message`, or a whole `@Cookie()` record typed otherwise, without schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | warning (error with `strictValidation`)        |
| ZNIGHT018 | Version mismatch or broken contract: metadata version, `@znight/*` release-line skew, extension `apiVersion`, malformed `package.json#znight` or compiled-library entry (skipped), untrusted (warning), failing or misbehaving compiler extension, generated-code syntax error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | error / warning                                |
| ZNIGHT019 | Unused provider (unreachable from roots, see `prune`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | warning (only with `reportUnused`)             |
| ZNIGHT020 | The generated module is imported (transitively) by a provider module (ESM cycle → TDZ crash), also through a path alias before the file exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | error                                          |
| ZNIGHT021 | Lifecycle hook, plugin hook or shutdown step failed or timed out (runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | error                                          |
| ZNIGHT022 | Syntax error: a scanned source file could not be parsed (reported first; the file is skipped, analysis continues)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | error                                          |
| ZNIGHT023 | Missing route decision: a route has no effective decision of a required route decorator group (build), or a decision that no guard of its chain enforces, of a required group or of a group a guard class of the application enforces (boot, every route in one error; one warning per group with `enforcement: 'warn'`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | error / warning                                |
| ZNIGHT030 | Invalid OpenAPI definition (`@OpenApiDocument` options or a second one, `@Api*` outside a controller or route handler, invalid static values, malformed `securityScheme()`; at boot: invalid `OpenApiPlugin` options, missing `extensions.openapi`, no `http` plugin; warnings: servers not reflecting the prefix, stale prebuilt file, prebuilt file without servers under a prefix)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | error / warning                                |
| ZNIGHT031 | Undocumented response: the success response of a route cannot be documented and no `@ApiResponse` covers it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | warning (error with `strict`)                  |
| ZNIGHT032 | Unrepresentable type: no JSON Schema, or not serialised as declared (`bigint` in a JSON response is always an error)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | warning / error (error with `strict`)          |
| ZNIGHT033 | Duplicate OpenAPI operation id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | error                                          |
| ZNIGHT034 | Schema name conflict: two declarations or schemas for one component name (compile time, a declaration named like a schema included; or at assembly, two schemas of one io under one name: hoisted `$defs` ids, `XInput` variants)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | error                                          |
| ZNIGHT035 | Inconsistent operation: the documentation contradicts the route (a body on 204/304, `@HttpCode(204)` or `304` with a body, another success status, `@ApiQuery`/`@ApiBody` duplicating the signature; warnings: `@ApiBody` on GET/HEAD, `@ApiExclude` with other `@Api*`, routes of one path naming their parameters differently, a whole-object parameter property documented twice at assembly)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | error / warning                                |
| ZNIGHT036 | Invalid security requirement (not a `securityScheme()`, scopes on a scheme without scopes, undeclared OAuth2 scopes, one scheme name for two definitions, invalid `decisions[].when` / `scopes: 'value'`; warning: a decision never applied)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | error / warning                                |
| ZNIGHT037 | Schema conversion failed while the document is assembled (boot, emission, tests): no converter, a converter throwing or returning a non-object, a whole-object `@Query(S)`/`@Param(S)`/`@Headers(S)` schema that is not an object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | error (warning with `unrepresentable: 'warn'`) |
| ZNIGHT040 | Invalid schedule: cron expression (syntax, range, never fires, `@reboot`), duration, time zone, job options, job method signature; at boot: `SchedulePlugin` options, `jobs` overrides, metadata, a zone unknown to the runtime's `Intl`; at runtime: `parseCron`, `parseDuration`, `registry.add*`, `reschedule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | error / warning                                |
| ZNIGHT041 | Duplicate job name (application and its libraries; `registry.add*` at runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | error                                          |
| ZNIGHT042 | Unknown job name (`jobs` override, with a did-you-mean hint; `registry.trigger` / `remove`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | error                                          |
| ZNIGHT043 | Missing lock store: a job requires a lock (`lock: true`) but `SchedulePlugin` has no store (boot; `registry.add*` at runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | error                                          |
| ZNIGHT044 | Job aborted: the reason of an aborted run's `ctx.signal` (`JobAbortedError`; `reason`: `timeout`, `lock-lost`, `removed`, `shutdown`); never thrown by the framework                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | error (a value)                                |

Codes are allocated by range (`rfcs/README.md`): `ZNIGHT001`–`029` belong to the core, the
compiler and the features shipped in 0.1 (http, messaging, config, observability); from
`ZNIGHT030`, each first-party package reserves a block of ten in the `@znight/core` catalogue
(`030`–`039` `@znight/openapi`, `040`–`049` `@znight/schedule`, `050`–`059` `@znight/websocket` and
`060`–`069` `@znight/graphql`, reserved for v0.2). Codes are allocated in order inside a block and
never change meaning. A package uses its block for its own failure modes, with one catch-all code
for invalid usage and options, and reuses a lower code when the meaning is the same (a decorator on
the wrong target is always ZNIGHT005). Third-party packages get no `ZNIGHT` code.

Singleton → transient is allowed (the singleton owns its instance). Error codes and descriptions
live in `@znight/core` (`ErrorCode`, `ERROR_DESCRIPTIONS`), shared by compiler and runtime.

ZNIGHT019 roots: extension providers, providers with `onStart`/`onReady`/`onStop`, classes
declared with `AnalyzeContext.addRoot` (§6.5: scheduled job hosts), also by compiled libraries
(`roots` of their fragment, §6.4), and classes referenced as values in application code (outside
types, imports, decorators and `extends`); a reference to an alias key counts for the aliased
provider. **Impl.** string lookups (`container.get('X')`) are not seen.

ZNIGHT020 never depends on the disk copy (a fresh checkout has none): when an import does not
resolve, a relative specifier is compared by path with the outFile, and an aliased one (tsconfig
`paths`, package `imports`, Vite string aliases) whose trailing segments name the outFile
(`@/.znight/container.generated.js`) is checked by resolving the same prefix with a scanned file
of the corresponding directory (`@/users/user.service.ts`). **Impl.** an alias mapping the outFile
itself (not a directory) is not detected before the file exists.

**Impl.** runtime conditions without a dedicated code reuse the closest one: container not
initialised, initialising or disposed → ZNIGHT015; duplicate plugin name, or an `HttpPlugin`
instance registered by a second application while the first one runs → ZNIGHT004; invalid plugin,
shutdown option or dependency reference, async interceptor result for a sync method → ZNIGHT005;
unknown `dispose` method, or an HTTP adapter instance bootstrapped by a second application →
ZNIGHT021; not a metadata object → ZNIGHT018.

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
| `@Intercept(Interceptor, options?)` | method                              | `Interceptor` value (provider class implementing `MethodInterceptor`), `options` value (typed from the interceptor, required unless it accepts `undefined`)           |

Type helpers: `Lazy<T>`; lifecycle interfaces `OnStart`, `OnReady`, `OnStop`. Every decorator
returns the same shared no-op function.

### `@znight/http`

| Decorator                                                                            | Target                                                                                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `@Controller(path? \| { path?, scope? })`                                            | class (provider, default singleton)                                                                                          |
| `@Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All(path?)`                          | method (several per method allowed)                                                                                          |
| `@Param(name?, schema?)` `@Query(name?, schema?)` `@Body(schema?)` `@Headers(name?)` | param                                                                                                                        |
| `@Cookie(name?, schema?)` `@SignedCookie(name, schema?)`                             | param — `name` static (an RFC 9110 token), `schema` value (RFC 0006, below)                                                  |
| `@Sse(path?, options?)` / `@Sse(options)`                                            | method — a `GET` route serving an event stream; options static `{ heartbeat?, retry?, maxDuration? }` (below)                |
| `@Req()` `@Res()` `@Ctx()`                                                           | param (raw request, raw response — adapter-specific escape hatch, warning — and `HttpContext`)                               |
| `@HttpCode(status)` `@Header(name, value)`                                           | method                                                                                                                       |
| `@UseGuard(...guards)` `@UseInterceptor(...interceptors)`                            | class / method (value refs, variadic)                                                                                        |
| `@Validate(schema)`                                                                  | method — sugar for `@Body(schema)`; using both is ZNIGHT005                                                                  |
| `@UploadedFile(field?, opts?)` `@UploadedFiles(field?, opts?)`                       | param — static (below)                                                                                                       |
| `@BodyLimit(size)`                                                                   | class / method — static `ByteSize` (bytes, `'10mb'`, `Infinity`); the method wins                                            |
| `createRouteDecorator<T>(key, { group?, required? }?)`                               | user-defined metadata decorators (`@Roles(['admin'])`, `@Public()`) → `meta[key]` of the controller or route; options static |

Upload parameters: `field` (static string, absent = files of every field) and options (static
`{ required?, maxSize?, mimeTypes? }`, plus `maxFiles?` for `@UploadedFiles`; `maxSize` is a
`ByteSize`, `kb` = 1024). `@UploadedFile` is typed `File` (or `Blob`; `node:buffer` types are cast),
`@UploadedFiles` `File[]`; `required` defaults to `true` unless the parameter is optional
(`file?: File`, `File | undefined`). Each field is read by one parameter, and a parameter without
field cannot be combined with other upload parameters (ZNIGHT005); upload parameters on a `GET`,
`HEAD`, `DELETE` or `OPTIONS` route are a ZNIGHT005 warning. `@Body()` on an upload route receives
the text fields.

Cookies (RFC 0006): `@Cookie('name') v: T` is coerced like `@Headers` (label `cookie "name"`, whose
messages never echo the value) or validated with `schema` (the issues of a `cookie "name"` or
`cookies` validation are redacted: message `Invalid value`, path reduced to its keys, since some
libraries quote the value in both); `@Cookie()` / `@Cookie(S)` injects every
cookie (`Record<string, string>`: another declared type without schema is ZNIGHT017).
`@SignedCookie('name', S?)` requires a name (ZNIGHT005) and injects the verified value of a signed
cookie with the same rules. Parameter sources `cookie` / `signedCookie` (§9.1).

`@Sse` (RFC 0006): `@Sse(path?, options?)` or `@Sse(options)` declares a `GET` route (`sse` in its
metadata, `{}` without options; `heartbeat: false` is stored as `0`). Options are integers:
`heartbeat` from 1 000 to 2 147 483 647 (2^31 − 1, the longest timer) or `false`, `retry` ≥ 0,
`maxDuration` from 1 000 to 2 147 483 647 (about 24.8 days); anything else, an unknown key or a
second argument after options is ZNIGHT005. `@Sse` cannot be combined with another route decorator
on the same method, `@HttpCode` (an event stream answers 200), `@Header('content-type')` or `@Res()`,
and a handler whose (awaited) return type is a string, number, boolean or literal is an error
(ZNIGHT005); generators, iterables, `ReadableStream`, `HttpResponse` unions and opaque types are
accepted. A request body (`@Body`, uploads) on an `@Sse` route is a ZNIGHT005 warning (`EventSource`
sends `GET` without body; `fetch()` clients streaming a `POST` use `@Post()` and
`HttpResponse.sse()`).

Route decorators (RFC 0001): `createRouteDecorator(key, options?)` takes a non-empty key and static
options `{ group?, required? }` (`required` default `false`; `group` default the key). The grammar
`/^[A-Za-z][\w.-]*$/` applies to an explicit `group` only: a decorator without `group` (or whose
`group` is its key) is its own group, named after its key, whatever the key (`'auth:public'`,
`'app/tag'`). Invalid values throw a `TypeError` when the module loads, and the compiler reports
them as ZNIGHT005. The decorator carries `key`, `group`, `required` (`RouteDecoratorInfo`), `get(ctx)`
(the effective value of the current route) and `meta(value?)` (the same metadata as data, `{ key,
value, group, required }`, for plugin routes, §9.1). Decorators of a group are alternatives: one
decision per group and target (ZNIGHT005), every definition of a key uses the same options, and the
decorators of a group agree on `required` (ZNIGHT005). For each route and each **required** group
seen during the compile (applied somewhere, or only defined: `definitionsOf`, §6.5), the compiler
looks for the effective decision (the route's, else the controller's) and reports ZNIGHT023 at the
route decorator when there is none, related to the group definition and the controller. Guards
declare the decisions they enforce with a static `enforces: readonly RouteDecoratorInfo[]`
(`GuardEnforcement`), read at boot (§9.1).

**Impl.** routes are not inherited: route decorators on a class without `@Controller` (e.g. a base
class) are ZNIGHT005; a route decorator created in a `.d.ts` (its key is not readable) is ZNIGHT005.

### `@znight/openapi`

| Decorator / function                                                                               | Target                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@OpenApiDocument(options?)`                                                                       | class (one per application, never instantiated) — static `OpenApiDocumentOptions` (`security`, `decisions`: value refs) |
| `@ApiOperation({ summary?, description?, operationId?, deprecated?, externalDocs?, extensions? })` | method — static                                                                                                         |
| `@ApiTags(...names)`                                                                               | class / method — static strings                                                                                         |
| `@ApiResponse<T>(status, options?)`                                                                | method, repeatable — status static (`404`, `'4XX'`, `'default'`), options static except `schema` (value); `T` read      |
| `@ApiBody<T>(options?)` `@ApiQuery<T>(name, options?)`                                             | method — what a handler reads outside its signature; options static except `schema` (value); `T` read                   |
| `@ApiHeader<T>(name, options?)`                                                                    | class / method — a header read by a guard or an interceptor                                                             |
| `@ApiSecurity(...requirements)`                                                                    | class / method — value refs to `securityScheme()` constants, arrays of them (AND) or `{ scheme, scopes }`; none: public |
| `@ApiExclude()`                                                                                    | class / method — not documented                                                                                         |
| `securityScheme(name, definition)`                                                                 | a top-level `const` (static arguments): an OpenAPI Security Scheme Object referenced by value                           |

Type arguments are read by the compiler (§6.5 `typeArgs`), never at runtime. `@Api*` outside a
controller or route handler, invalid static values and a second `@OpenApiDocument` are ZNIGHT030.

### `@znight/schedule`

| Decorator                     | Target                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Cron(expression, options?)` | method — static expression (5 or 6 fields, names, `L`, `5L`, `MON#2`, nicknames); static `{ name?, enabled?, lock?, maxDuration?, overlap?, runOnStart?, timeZone? }` |
| `@Interval(every, options?)`  | method — static `Duration` (ms or `'30s'`, epoch-aligned); options as `@Cron` without `timeZone`                                                                      |
| `@Timeout(delay, options?)`   | method — static `Duration` after the scheduler started; `{ name?, enabled?, lock?, maxDuration? }`                                                                    |

A job is a public instance method declared by its class (not inherited), taking no parameter or one
`ctx: JobContext`; the host is any provider, or becomes a singleton provider through
`AnalyzeContext.addRoot` (§6.5). Several triggers on one method each need a `name`; a method cannot
be a job and a route or message handler (ZNIGHT005). Names match `^[\w$][\w.:$-]{0,127}$`, default
`<Class>.<method>`, and are unique across the application and its libraries (ZNIGHT041). Every
invalid expression, duration, time zone or option is ZNIGHT040, located in the faulty field of a
literal.

### `@znight/messaging`

| Decorator                                                                             | Target                                                                                       |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@Consumer(queue \| { queue, scope?, concurrency?, deadLetter?, ...driver options })` | class (provider) — static                                                                    |
| `@OnMessage(type?)`                                                                   | method; exact type or pattern (`*` matches any sequence); several per method; none = default |
| `@Retry({ attempts, backoff?, delay?, maxDelay? })`                                   | method — static, unknown keys are ZNIGHT011                                                  |
| `@OnError()`                                                                          | method `(error, message) => void \| 'ack'`                                                   |
| `@Message(schema?)` `@Headers(name?)` `@Ctx()`                                        | param (`schema` value, `name` static)                                                        |

Handlers and `@OnError` are inherited from analysable base classes.

### `@znight/config`

| Decorator                       | Target                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `@Config(prefix?)`              | class (singleton provider)                                                                |
| `@Env(name)` / `@Secret(name?)` | property (`@Secret` masks the value; with both, the names must match)                     |
| `@Default(value)`               | property — static only, checked against the type (use an initializer for computed values) |
| `@Key(path)`                    | property (file sources key, default `<prefix>.<property>`)                                |

### `@znight/observability` (interceptor decorators, declared in the manifest, §7)

`@Logged(opts?)` → `LoggedInterceptor`, `@Traced(opts?)` → `TracedInterceptor`,
`@Metric(opts?)` → `MetricInterceptor`. Options are literals (`LoggedOptions`, `TracedOptions`,
`MetricOptions`), validated by the plugin at boot.

## 6. Compiler

### 6.1 Pipeline

```
scan (include/exclude + source libraries) → parse (oxc, cached by content hash)
→ per-file facts (imports, exports, declarations; cached) → resolve identities (global)
→ analyse classes (core + extensions) → merge compiled provider libraries → bind (§4.7)
→ validate (§4.8) → emit (literal emitter, import routes) → re-parse check → write if content changed
```

Only parsing and per-file facts are cached. Everything from resolution onward is recomputed
globally on each compile (cheap). Compiles of one `createCompiler()` instance are serialised; calls
made during a compile are coalesced into the next one. Debouncing file events (~50 ms) is the
watcher's job (Vite plugin, CLI). Syntax errors (ZNIGHT022) are reported first; the file is
skipped and analysis continues.

### 6.2 Public API

```ts
// '@znight/compiler'
export function compile(options?: CompileOptions): Promise<CompileResult> // pure: reads sources only
export function generate(options?: CompileOptions & GenerateOptions): Promise<GenerateResult>
export function createCompiler(options?: CompileOptions): ZnightCompiler // incremental
export function formatDiagnostics(diagnostics: readonly Diagnostic[], options?: FormatDiagnosticsOptions): string
export function renderErrorModule(diagnostics: readonly Diagnostic[], options?: RenderErrorModuleOptions): string
export const COMPILER_VERSION: string // from its package.json
export const EXTENSION_API_VERSION = 1
export const PROVIDERS_FILE = 'znight.providers.json', PROVIDERS_SCHEMA_VERSION = 1
// tooling: Project, normalizeOptions, analyze, analyzeProject, loadExtensions,
// discoverExtensionModules, validateExtension, createGenBuilders, isGenNode, DEFAULT_* constants
// watch helpers of custom watchers (the Vite plugin, the preload and `znight generate --watch` agree):
export function includeRoots(compiler: ZnightCompiler): string[] // include directories (project, source libraries)
export function isRelevantChange(compiler, kind: ChangeKind, file, watched: ReadonlySet<string>, roots): boolean
export function znight(options?: ZnightOptions): Plugin<ZnightPluginApi> // Vite plugin, also the default export (§6.3)
// Bun (side-effect free; the ready-made preload is '@znight/compiler/bun', §6.3)
export function createPreload(options?: PreloadOptions): Promise<GenerateResult>
export function znightBunPlugin(options?: ZnightBunPluginOptions): ZnightBunPlugin
export function loadZnightConfig(cwd?: string): Promise<LoadedZnightConfig> // { file, options }
export const ZNIGHT_CONFIG_FILES: readonly string[] // znight.config.{ts,mts,js,mjs}

interface ZnightOptions {
  root?: string // default: Vite root / process.cwd()
  include?: string[] // default ['src/**/*.{ts,tsx,mts}']
  exclude?: string[] // default ['**/*.{test,spec}.*', '**/*.d.ts', '**/.znight/**'] (+ node_modules, dot-dirs, outFile)
  outFile?: string // default 'src/.znight/container.generated.ts'
  tsconfig?: string | false // default: nearest tsconfig of each importing file
  conditions?: string[] // extra scan conditions
  importExtension?: 'js' | 'ts' | 'none' // default 'js'
  sourceLocations?: 'dev' | 'always' | false // default 'dev'
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
interface CompileOptions extends ZnightOptions {
  mode?: 'build' | 'serve' | 'test' // default 'serve' (source locations, §3.3)
  cwd?: string // base of a relative root, default process.cwd()
  runtimeConditions?: string[] // Vite resolve.conditions, default ['node', 'import', 'default']
  aliases?: { find: string; replacement: string }[] // Vite string aliases
}
interface CompileResult {
  code: string // generated module, or the error module (§3.3) when !ok
  diskCode: string // the disk copy: the `serve` rendering in every mode (§3.3)
  outFile: string // absolute
  diagnostics: Diagnostic[] // ZNIGHT022 first, then sorted by file and offset
  ok: boolean // no error diagnostic
  graph: ApplicationGraph // pruned with `prune`
  stats: { files: number; providers: number; durationMs: number; parsed: number }
  library: LibraryOutput | undefined // library mode only: znight.providers.json
  watchFiles: string[] // sources, files read outside node_modules, manifests, libraries; never outFile
  decorators: ReadonlyMap<string, DecoratorRanges> // per analysed file, for stripDecorators (§6.3)
}
interface GenerateOptions {
  check?: boolean // never write; report `stale`
}
interface GenerateResult extends CompileResult {
  written: string[] // files whose content changed (none when !ok)
    stale: boolean // check mode: generated files missing or out of date
  staleFiles: string[] // check mode: which ones, the module first (then znight.providers.json)
}
interface ZnightCompiler {
  options: ResolvedOptions
  project: Project
  mode: CompileMode
  last: CompileResult | undefined
  compile(changes?: { changed?; added?; removed? }): Promise<CompileResult> // only changed files re-read
  generate(changes?, options?: GenerateOptions): Promise<GenerateResult>
  isOutFile(file: string): boolean // watchers must ignore the generated module
  reloadExtensions(): void
}
interface Diagnostic {
  code: ErrorCode
  severity: 'error' | 'warning'
  message: string
  location?: { file; line; column; endLine; endColumn; start; end } // absolute POSIX path, UTF-16
  hints?: string[]
  related?: { message; location }[]
}
```

- `compile()` never writes. `generate()` writes the generated module (`diskCode`, and
  `dist/znight.providers.json` in library mode) only when its content changed and there is no
  error; with `check` it never writes and `stale` compares the same files with the disk. The disk
  copy is the `serve` rendering whatever the mode (it differs from `code` only in `build` mode,
  whose bundle drops provider `source` locations), so every tool (`znight generate`, `vite build`,
  the Bun preload under any `NODE_ENV`, `--check` after a build) writes and expects one file.
  `createCompiler()` keeps the parse cache and the loaded extensions between compiles; changes to
  `outFile` are ignored.
- `watchFiles` lists every file the result depends on: the scanned sources and every other file the
  analysis read outside `node_modules` (a constant imported from `shared/`, a type of
  `src/types.d.ts`, a workspace package), package manifests and compiled libraries; never the
  outFile. Watchers also recompile when a file is created where a relative import of the last
  compile did not resolve.
- Options are validated by `normalizeOptions` (a `TypeError` prefixed `[znight]` naming the
  option); paths are absolute and POSIX, the root is a realpath.
- **Version skew** (ZNIGHT018, located in the `package.json`): `@znight/core` and every `@znight/*`
  dependency of the root package MUST belong to the compiler's release line (same minor in `0.x`,
  same major from `1.0`).
- Locations: 1-based lines, columns in UTF-16 code units (BOM included), `start`/`end` UTF-16
  offsets (like tsc and LSP).
- `formatDiagnostics(diagnostics, { color?, cwd?, readFile?, summary? })` prints rustc-like code
  frames (carets under the exact range, `:::` for related locations, `= hint:` lines, summary line
  `Build failed with 2 errors`); `NO_COLOR` always disables colors:

```
✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService
  --> src/notification/notification.service.ts:12:29
   |
12 |     private readonly email: EmailService,
   |                             ^^^^^^^^^^^^
   = hint: EmailService (src/email/email.service.ts:3) is not a provider: add @Injectable()
```

- `renderErrorModule(diagnostics, { cwd?, readFile?, version? })`: the error module of §3.3 (the
  `ZnightError` code is the one of the first error).

### 6.3 Vite plugin and Bun preload

Both integrations are built on `createCompiler()` (incremental compiles, `decorators`, `watchFiles`,
`isOutFile`) and exported by `@znight/compiler`, which only `import type`s from `vite` (importing the
compiler never loads Vite).

**Vite plugin.** `znight(options)` is the named and default export. One incremental compiler per
plugin instance, shared by every environment the plugin applies to.

- `plugin.api` (`ZnightPluginApi`): `options` (the options given to `znight()`, unchanged; read by
  `znight generate`), `compiler` (created in `configResolved`), `result` (the latest
  `CompileResult`, `undefined` before the first compile; read by `znight dev`) and `ready()`
  (compiles the pending changes, resolves with the up-to-date result).
- Applies to the server environments only (`applyToEnvironment`: `consumer === 'server'`: SSR,
  Vitest's Node.js environment); client environments are left alone.
- `config`: when `app !== false` and the user configured neither `build.ssr` nor `build.lib`:
  `build.ssr = entry` (`app.entry`, default `src/main.ts`), `build.outDir = 'dist'`,
  `build.target = 'node24'`, `build.sourcemap = true`, `ssr.target = 'node'`, each only when unset.
  The dev server watcher and `build.watch` ignore the outFile (and the temporary files of its atomic
  writes).
- `configResolved`: creates the compiler with `cwd` = Vite root, the compile mode, the runtime
  conditions (`resolve.conditions` of the server environment, `development|production` mapped, plus
  `node`, `import`, `default`) and the string `resolve.alias` entries; it is kept while these inputs
  do not change. Mode: dev server → `serve` (`test` under Vitest or `--mode test`); `vite build` →
  `build`, except a development build (`--mode development`, used by `znight dev`) → `serve`.
- `buildStart`: compiles (the first compile of a session is full, later ones only re-read the
  recorded changes). In `vite build`: errors fail the build (a `ZnightError` whose message is the
  formatted diagnostics, with `code` (first error) and `diagnostics`) and nothing is written. In
  `vite build --watch` and the dev server: diagnostics are printed through the Vite logger
  (deduplicated in the dev server) and, with errors, the generated module is replaced by the error
  module (§3.3): **the build does not fail**; tools check `plugin.api.result.ok` (`znight dev`
  keeps the last good process).
- `resolveId`/`load` (hook filters on the outFile name): relative, absolute and root-relative
  imports of the outFile, with a JS/TS extension or none, resolve to it and are served from memory
  (the latest result, after the pending debounced compile). The disk copy (`diskCode`, the same in
  every mode, §6.2) exists for `tsc` and editors and is written only when its content changed and
  the compile is ok; writing it is best-effort: a failure (read-only tree of a container image) is
  a warning, never a build failure. Imports through an alias are not intercepted (they read the
  disk copy).
- Watching: in `vite build --watch`, the include roots, every file of `watchFiles`, the root
  `tsconfig.json` and the `tsconfig` option are watched (`addWatchFile`); `watchChange` records the
  relevant events (a creation of a known file is a change, and so is a creation where a relative
  import did not resolve) for the next `buildStart`. In the dev
  server, listeners are prepended to the server watcher (the change is recorded before Vite reloads
  an importer), events are debounced (~50 ms, one compile per burst), `hotUpdate` adds the generated
  module to the HMR batch and a new result reloads it in the server environments. File
  create/unlink re-runs the globs; `package.json`/`tsconfig*.json`/lockfile changes clear the
  resolver cache.
- `transform` (`enforce: 'pre'`, filter on JS/TS ids): strips exactly the decorator ranges
  recorded by the last analysis of that file content (below; never re-decides); when a compile is
  running or due for a scanned file, it waits for it. Files not analysed, virtual ids and the
  generated module are untouched. High-resolution source maps via `magic-string`.
- `writeBundle`: library mode writes `dist/znight.providers.json` (§6.4).

**Decorator ranges** (`CompileResult.decorators`: `ReadonlyMap<file, DecoratorRanges>`, scanned files
only): `{ hash, ranges, memberStarts }`. `hash` is the content hash of the analysed file: ranges
apply only while the content still has it. `ranges` are the `[start, end)` UTF-16 offsets (`@`
included) of the decorators owned by the core, an extension or a manifest, sorted, de-duplicated and
non-overlapping. `memberStarts` are the starts of the ranges beginning a class member (the first
decorator of a method, accessor or property): stripping replaces that range with `;` (an empty class
element), so that a preceding field without semicolon cannot absorb the member (`x = a` +
`[key]() {}` → `x = a[key]() {}`).

**Bun preload.** `@znight/compiler/bun` (`bunfig.toml` `[test] preload` or top-level `preload`,
`bun --preload`, also with `--watch` / `--hot`): importing it **runs**
`createPreload((await loadZnightConfig()).options)`. The side-effect-free API is exported by the
package root:

- `loadZnightConfig(cwd = process.cwd())` → `{ file, options }`: the default export of the first of
  `znight.config.ts`, `.mts`, `.js`, `.mjs` in `cwd` (`ZNIGHT_CONFIG_FILES`), or of the file named by
  the `ZNIGHT_CONFIG` environment variable (resolved against `cwd`; a missing file is an error): an
  options object, or a (possibly async) function returning one (anything else is a `TypeError`).
  A relative `root` is resolved against the config file directory (its default). Without a file:
  `{ file: undefined, options: { root: cwd } }`. `znight generate` reads the same file, and
  `vite.config.ts` imports it (`znight(options)`), so every tool compiles with the same options.
- `createPreload(options)` (Bun only: `Bun.plugin`): `PreloadOptions` = `CompileOptions` +
  `logLevel` (`'info'` adds a summary line, `'warn'` (default) prints diagnostics only, `'silent'`;
  everything on stderr). Mode `test` under `NODE_ENV=test` (`bun test`), `build` with
  `NODE_ENV=production`, else `serve`; runtime conditions `bun, node, import, default`. It generates
  the module (disk copy, the same in every mode, written when it changed; a write failure is a
  warning on stderr, since the module is served from memory — but Bun resolves the import only when
  the file exists: generate it when building a read-only image), loads every file of `watchFiles`
  and the tsconfigs **as text modules** (`import(url + '?znight-watch', { with: { type: 'text' }
  })`: read, never executed) so that `bun --watch` / `bun test --watch` restart when they change —
  also after a failed compile —, prints the diagnostics, throws a `ZnightError` (code of the first
  error, no stack) on errors (`bun test` exits 1, `--watch` waits for a fix), then registers
  `znightBunPlugin`. Resolves with the `GenerateResult`.
- `znightBunPlugin({ compiler?, ...CompileOptions })` → `{ name, compiler, setup }`: `setup`
  compiles unless the compiler already has a result; `onLoad` of the outFile serves the result from
  memory (the first load reuses the preload result, later loads — `bun --hot` — recompile
  incrementally); `onLoad` of the analysed files **blanks** the decorator ranges (replaced by spaces,
  line breaks kept, member starts by `;`): every position is unchanged, no source map needed
  (`stripDecorators: false` disables it).
- **Impl.** Bun restarts watch processes only for files it loaded: a newly created file is picked up
  at the next restart.

### 6.4 Provider libraries

- **Source libraries**: packages listed in `libraries`, or whose manifest has
  `"znight": { "library": "source" }` (discovered among the root package's direct dependencies), are
  scanned from their sources when their public entries resolve to TypeScript with the scan
  conditions. Their files are the application `include`/`exclude` globs applied inside the package
  directory, plus the entry files. Their providers get package identities and package import routes,
  so dev and prod agree.
- **Compiled libraries** (`library: true`): the compiler emits `dist/znight.providers.json`
  (`schemaVersion: 1`, `package`, `compiler`, `providers`, `edges`, `bindings`, `extensions`):
  providers with token, kind (`class` / `provides`), class identity and import route, provided type,
  heritage closure, scope, name/primary, async/dispose, lifecycle members, injection points (encoded
  `TypeInfo` + qualifier + optional), interceptor chains with options, extension edges and
  `bindInjection` requests, the data stored by extensions and, optionally, `roots` (the sorted tokens
  of the providers declared with `AnalyzeContext.addRoot`, absent when there is none, so the output of
  a library without roots is unchanged; the application keeps them under `prune` and never reports
  them as unused). Identities are translated to the
  package's public exports; values JSON cannot represent are tagged (`{ "$znight": "bigint", ... }`).
  Referenced by `"znight": { "providers": "./dist/znight.providers.json" }`; the application
  compiler merges fragments before binding and validates their dependencies against its own
  providers. The shape of every provider, binding, edge and extension entry (encoded `TypeInfo`
  included, in depth) is checked while merging: a malformed or version-skewed entry is a ZNIGHT018
  "malformed ..." error naming the library and its file, the entry is skipped and the compile goes
  on (never a crash).
- Library mode rules: missing providers are warnings (the application may implement them);
  providers and referenced values MUST be exported by a public entry; the library's public entries
  MUST resolve to its sources with the scan conditions while it is compiled; providers with an
  extension custom factory (e.g. `@Config` classes) are refused — publish such libraries as source
  libraries. **Impl.** locations of compiled-library providers point to the package declarations.

### 6.5 Compiler extensions

```ts
interface CompilerExtension<TData = unknown> {
  apiVersion: 1
  name: string // key in metadata.extensions (unique)
  decorators: Record<Identity, DecoratorSpec> // canonical identity -> spec
  analyzeClass?(cls: ClassInfo, ctx: AnalyzeContext<TData>): void
  validate?(ctx: ValidateContext<TData>): void
  generate?(ctx: GenerateContext<TData>): GenNode | undefined
}
interface DecoratorSpec {
  targets: ('class' | 'method' | 'property' | 'parameter' | 'constructorParameter')[]
  params: ('static' | 'value')[] // positional arguments
  rest?: 'static' | 'value' // variadic tail, e.g. @UseGuard(...guards)
}
```

- **Loading**: built-in core analysis + extensions of packages referenced through
  `package.json#znight.compiler` (the module default-exports an extension or an array of them),
  resolved with the runtime conditions (plus `@znight/source` when running under Bun). A package is
  discovered when the scanned code imports it (bare specifier) **or** when it declares a decorator
  applied to a scanned class: decorator callees are resolved to their declaration, so a preset
  re-exporting `Controller` from `@znight/http` (`import { Controller } from '@acme/web'`) loads the
  `@znight/http` extension, under the same trust rules. `@znight/*`
  packages are trusted; third-party packages need `trustedExtensions` (otherwise a ZNIGHT018 warning
  and the extension is not loaded). Explicit `extensions` options win over discovered extensions of
  the same name; duplicate names from different paths/versions → ZNIGHT018. An extension that fails
  to load, throws in a hook or returns a forged node is reported as ZNIGHT018 naming it; the compile
  continues.
- **Calls**: core checks targets and argument kinds of declared decorators (ZNIGHT005) first;
  `analyzeClass` is then called only for classes carrying at least one of the extension's
  decorators, in identity order; `validate` after binding; `generate` during emission.
- `ClassInfo`: `name`, `identity`, `displayName`, `file`, `relativeFile`, `location`, `exported`,
  `importRoute`/`importError`, `abstract`, `ambient`, `typeParameters`, `decorators`, **`ctor`**
  (`ConstructorInfo`: params resolved through inheritance, `declaredBy`, `visibility`, `error`;
  named `ctor` because `constructor` collides with `Object.prototype.constructor`), `methods` (name,
  kind, visibility, `privateName`, `computed`, static, abstract, async, generator, optional,
  decorators, params, return type, type parameters), `properties` (name, visibility, readonly,
  optional, declare, accessor, decorators, type, `initializer: ArgInfo`), `superClass`, `heritage`
  closure, `lifecycle`, `decorated`, `declaration`. Classes, methods, properties and parameters also
  carry `doc: DocComment | undefined`: the JSDoc block before the declaration, found through
  decorators and `export` / `default` / `declare` modifiers: `{ text, summary, description, tags:
  { name, text, location }[], location }`, where `summary` is the first paragraph of `text` (its
  lines joined) and `description` the rest; `@example` blocks keep their line breaks.
- `DecoratorInfo`: `{ identity, name, owner, args: ArgInfo[], typeArgs: TypeInfo[], called, target,
  location, node }` (`typeArgs`: the resolved type arguments of the call, `@ApiResponse<Book[]>(200)`,
  erased at runtime); `ParameterInfo`: `{ name, index, type, optional, hasDefault, initializer, rest,
  decorators, location, typeLocation, property, doc }`, where `initializer` is the default value
  evaluated like a `value` argument (`limit = 20`), never reported, `undefined` without default
  (and for compiled libraries: declaration files do not keep default values).
- `ArgInfo`: `{ kind, evaluated, value?: StaticValue, ref?: ValueRef, error?, location, text, node }`
  (`evaluated` distinguishes an evaluated `undefined` from a non-evaluable argument).
- `AnalyzeContext`: `extension`, `project`, `options`, `types` (`format`, `serialize`, `equals`,
  `stripNullish`, `awaited`), `registerProvider(cls, { scope?, name?, primary?, factory? }) → Token`
  (a class registered by two decorators is ZNIGHT005), `resolveClassRef(arg | ValueRef, { from?,
  role? }) → ClassRef | undefined` (auto-registers injectable helper classes such as guards),
  `bindInjection(request, { from? }) → BindingHandle` (read back with `binding(handle)`),
  `addDependency(from, to, { location?, reason? })`, `classInfo(identity)`, `report(diagnostic)`,
  `store(data)` (appended, read back as `stored`), `addRoot(cls, { reason?, location? }) → Token` and
  `definitionsOf(callee) → DefinitionInfo[]` (below).
- **Roots** (`addRoot`): declares a class the extension's plugin uses at runtime although no binding
  reaches it (a class whose only entry point is a `@Cron` method). Its provider is a root of
  ZNIGHT019 and `prune` (§4.8), also through compiled libraries (§6.4). When no provider decorator
  (core or extension) registers the class by the end of the analysis, it is registered as a
  singleton with constructor injection (`registeredBy: 'auto'`, like the helper classes of
  `resolveClassRef`), so a host already registered as `@Injectable`, `@Controller` or `@Consumer`
  keeps its registration. Idempotent. `ApplicationGraph.roots: RootNode[]` (`{ token, origin, reason,
  location }`, sorted by token then origin) lists them; it is always computed, also without
  `reportUnused` or `prune`.
- **Definitions** (`definitionsOf(callee)`, also in `ValidateContext`): the top-level `const`
  declarations of the scanned files (application and source libraries) initialised with a call to
  the function of canonical identity `callee` (`'@znight/http#createRouteDecorator'`), applied
  anywhere or not, sorted by identity: `{ identity, name, displayName, file, location, call, args,
  typeArgs, doc, exported }` (`args` evaluated as `value` arguments, nothing reported). Computed once
  per compile and callee. **Impl.** compiled libraries and constants inside namespaces are not seen.
- **Extension edges** (`addDependency`, `resolveClassRef({ from })`, `bindInjection({ from })`)
  count for ZNIGHT003 and ZNIGHT019/`prune`, never for ZNIGHT002 nor `resolutionOrder`: the plugin
  resolves them at runtime. **Impl.** consequence: a singleton controller using a request-scoped
  guard is reported as ZNIGHT003.
- `CustomFactory`: `{ deps: InjectionRequest[]; async?: boolean; generate(ctx, { cls, deps }):
  GenNode }` — `deps` are bound with §4.7 and passed as nodes (`d[i]`).
- `ValidateContext`: `extension`, `project`, `options`, `types`, `graph` (`ApplicationGraph`),
  `stored`, `provider(token)`, `classInfo(identity)`, `binding(handle)`, `report(diagnostic)`,
  `definitionsOf(callee)`.
- **Type shapes** (`types.shape(target, options?) → ShapeResult`, in the analyze, validate and
  generate contexts): the structural view of a type annotation, what a value of that type looks like
  once serialised as JSON, computed from declarations (sources and `.d.ts` alike, no type checker)
  for schema generators such as `@znight/openapi`.
  - Targets: `{ returnOf: MethodInfo }` (a top-level `Promise<T>` unwrapped), `{ parameter }`,
    `{ property }`, `{ decorator, typeArgument }` (a type argument of a decorator call) and
    `{ type: TypeInfo }` (aliases already expanded: less precise).
  - `Shape`: keywords (`string`, `number`, `boolean`, `null`, `undefined`, `unknown`, `never`,
    `date`, `bigint`, `binary`, `url`), `literal`, `array`, `tuple`, `object` (`properties` with
    `optional`, `readonly` and `doc`, `additional` for index signatures and records), `union` /
    `intersection` (normalised like `TypeInfo` unions), `named` (`key` of an interface, class, alias
    or enum: recursion goes through named shapes), `schema` (`{ ref, io }`: a Standard Schema behind
    one of `schemaAliases`, `z.output<typeof S>`), `reference` (a type listed in `keep`, not
    expanded, with its `typeArgs` and `explicitTypeArgs`) and `opaque` (`{ text, reason }`).
  - Interfaces are flattened with their `extends` and merged declarations; classes are their
    serialised fields (parameter properties first; no methods, accessors, static, `#private` nor
    TypeScript `private` members; a `toJSON()` method gives the shape of its annotated return type);
    generics, the usual utility types (`Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `Record`,
    `NonNullable`, `Exclude`, `Extract`, `Awaited`), `keyof`, indexed access and mapped types over
    literal keys are applied structurally.
  - Enums are the union of their member values, in declaration order; an enum member type
    (`Kind.Cat`, also through a namespace import or an enum declared in a namespace) is the literal
    of its value (an unknown member: `opaque`, reason `unresolved`). Key positions (`Record<K, V>`,
    mapped types, the keys of `Pick` / `Omit`, the index of `T[K]`) and the members filtered by
    `Exclude`, `Extract` and `NonNullable` go through the members of enums and of aliases of
    unions, literals or primitives: `Record<Genre, number>` has one required property per member,
    `{ [K in Genre]?: T }` one optional property per member, `Exclude<Status, 'deleted'>` drops the
    member. A filter that removes nothing keeps the named shape (`NonNullable<Pet>` stays `Pet`);
    `Record<never, T>` (or an empty enum) is `{}`. **Impl.** the `{ type: TypeInfo }` target keeps
    `Kind.Cat` opaque (`unresolved`).
  - Options: `schemaAliases` (identity → `'input' | 'output'`, matched before alias expansion, also
    through aliases of them), `schemaMembers` (members meaning the type of a schema value, ArkType
    `typeof S.infer`), `keep` (identities kept as `reference`), `jsdoc` (default `true`).
  - `ShapeResult`: `root`, `named` (every named shape reached, transitively, by key, sorted; a
    declaration only used structurally is not listed) and `issues` (every `opaque` part and every
    `bigint`, with a path, the key of the named shape declaring it and a location). Results are
    cached per compile and options; named shapes and issues are shared objects (de-duplicate issues
    by identity); the files read are part of `watchFiles`. The extension decides the severity of
    issues.
- `GenerateContext`: pure builders `lit`, `obj`, `arr`, `ref`, `member`, `call`, `construct`,
  `arrow` (typed parameters), `code` (tagged template escaping every interpolation) — also available
  as `createGenBuilders()` — plus `importValue` / `importType(ValueRef | ArgInfo | ClassInfo |
  ClassRef | identity)`, `importFrom(bareSpecifier, name, { type? })`, `tokenOf(target)`,
  `binding(handle)`, `provider(token)`, `constant(name, value, { type? })` (§3.3), `report`, and
  `extension`, `options`, `types`, `graph`, `stored`. Raw strings are never accepted; nodes not
  created by the builders are rejected (ZNIGHT018); an import that cannot be routed is ZNIGHT005
  naming the extension. A custom factory receives the same context as the extension section, so
  constants are shared.

## 7. Package manifest (`package.json#znight`)

```jsonc
"znight": {
  "apiVersion": 1,                               // missing: warning, 1 assumed; unsupported: error, manifest ignored
  "compiler": "@znight/http/compiler",          // module(s) default-exporting a CompilerExtension (string or array)
  "provides": [                                  // externals: types provided at runtime by a plugin
    { "export": "Logger", "plugin": "ObservabilityPlugin", "scope": "singleton" },
    { "export": "HttpContext", "plugin": "HttpPlugin", "scope": "request" }   // + "optional": true
  ],
  "interceptors": [{ "decorator": "Logged", "interceptor": "LoggedInterceptor" }],
  "library": "source",                           // optional: provider library analysed from source
  "providers": "./dist/znight.providers.json"    // optional: compiled provider library
}
```

Export names refer to the package's public entry; tokens are `<package>#<export>`. Every manifest
problem is a ZNIGHT018 diagnostic located in the `package.json`; malformed entries are skipped.

Manifests of the `@znight/*` packages:

| Package                 | `compiler`                   | `provides` (export → plugin, scope)                                                                                                      | `interceptors`                                                                                 |
| ----------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@znight/core`          | —                            | `Container` → `@znight/core`; `Application`, `Hooks`, `CoreLogger` → `Application` (all singleton)                                       | —                                                                                              |
| `@znight/http`          | `@znight/http/compiler`      | `HttpContext`, `RequestId` → `HttpPlugin` (request); `HttpPlugin` → `HttpPlugin` (singleton)                                             | —                                                                                              |
| `@znight/messaging`     | `@znight/messaging/compiler` | `MessageBroker` (singleton), `InboundMessage` (request) → `MessagingPlugin`                                                              | —                                                                                              |
| `@znight/config`        | `@znight/config/compiler`    | `ConfigSource` → `ConfigPlugin` (singleton)                                                                                              | —                                                                                              |
| `@znight/observability` | —                            | `Logger`, `MetricsRegistry`, `Tracer`, `LoggedInterceptor`, `TracedInterceptor`, `MetricInterceptor` → `ObservabilityPlugin` (singleton) | `Logged` → `LoggedInterceptor`, `Traced` → `TracedInterceptor`, `Metric` → `MetricInterceptor` |
| `@znight/openapi`       | `@znight/openapi/compiler`   | `OpenApi` → `OpenApiPlugin` (singleton)                                                                                                  | —                                                                                              |
| `@znight/schedule`      | `@znight/schedule/compiler`  | `SchedulerRegistry` (singleton), `JobContext` (request) → `SchedulePlugin`                                                               | —                                                                                              |

`@znight/compiler`, `@znight/testing` and `@znight/cli` have no manifest. Subpath exports:
`@znight/http` (`/node`, `/fastify`, `/express`, `/hono`, `/path`, `/compiler`), `@znight/messaging`
(`/memory`, `/rabbitmq`, `/sqs`, `/kafka`, `/compiler`), `@znight/config` (`/compiler`),
`@znight/openapi` (`/compiler`, `/emit`, `/vite`, `/testing`; RFC 0002), `@znight/schedule`
(`/compiler`, `/testing`; RFC 0004); the CLI has the `znight` bin.

## 8. Core runtime (`@znight/core`)

### 8.1 Container

```ts
class Container {
  static create(metadata: ZnightMetadata): Container // ZNIGHT018: not metadata / unsupported version
  readonly metadata: ZnightMetadata
  register<T>(token: TypedToken<T>, definition: ProviderDefinition<T>): void // plugin level
  registerValue<T>(token: TypedToken<T>, value: T): void // plugin level
  registerExternal(external: ExternalDefinition): void // e.g. a request-scoped external
  provide<T>(key: ProviderKey<T>, value: T): void // application level
  override<T>(key: ProviderKey<T>, valueOrDefinition: T | ProviderDefinition<T>): void // aliases resolved first
  init(options?: { only?: ProviderKey[] }): Promise<void> // a second call returns the first promise
  get<T>(key: ProviderKey<T>): T
  getOptional<T>(key: ProviderKey<T>): T | undefined
  has(key: ProviderKey): boolean
  tokenOf(key: ProviderKey): Token | undefined
  instances(): ManagedInstance[] // created singletons in resolution order, idempotent dispose()
  runInScope<R>(fn: () => R | Promise<R>, values?: Iterable<[ProviderKey, unknown]>): Promise<R>
  currentScope(): ScopeContext | undefined // get / has / set / closed
  dispose(): Promise<void>
}
type ProviderKey<T> = TypedToken<T> | ProviderClass<T> | ClassKey<T> // ClassKey: classes with private constructors
```

- **Precedence**: `override` > plugin `register`/`registerValue` > `provide`
  (`Application.create({ providers })`) > core built-ins > compiled. A plugin registration of a
  compiled token throws ZNIGHT004 (use `override`); any registration of an overridden token is
  ignored. Two registrations at the same level (plugin vs plugin, provide vs provide) → ZNIGHT004
  naming the first registrant; a later `override` replaces an earlier one. Any registration after
  `init()` → ZNIGHT016.
- **Built-ins** (`CoreTokens`): `@znight/core#Container`, `#Application`, `#Hooks`, `#CoreLogger`,
  declared in the core manifest so user providers can inject them.
- **Init**: a runtime topological sort merges `resolutionOrder` with runtime definitions; ZNIGHT001,
  ZNIGHT002, ZNIGHT003 and ZNIGHT014 are re-checked on the merged graph (runtime definitions bypass
  the compiler). Each singleton factory starts as soon as its dependencies settle (independent async
  singletons run concurrently). `only` instantiates the dependency closure of the given keys; other
  synchronous singletons (and the target of a `Lazy.get()` called during `init()`) are created on
  first use, async ones outside the closure are refused (ZNIGHT015) and a re-entrant creation is
  ZNIGHT002. A singleton created on demand while a request scope is active is created outside of it
  (`AsyncLocalStorage.exit`): its factory, dependencies and interceptors never capture the scope of
  the request that used it first.
  Missing externals are reported together (ZNIGHT001 naming `providedBy`). Factory errors are
  wrapped in ZNIGHT015 (`InstantiationError`: token, dependency path, source, `cause`). On failure,
  already created instances are disposed in reverse creation order, then the error is rethrown
  (cleanup errors attached).
- **Interceptors** (`definition.interceptors`) are applied by the container right after the factory,
  for every scope.
- **Request scope**: `runInScope` opens a scope (AsyncLocalStorage) seeded with key-value pairs;
  request-scoped providers and request-scoped externals are resolved from it (ZNIGHT013 when
  absent); a seed value for a token bound as singleton/transient is ignored (the binding wins);
  instances created in the scope are disposed in reverse creation order when `fn` settles (only a
  disposal failure rejects, with ZNIGHT021).
- **Lifecycle** is duck-typed on instantiated singletons (compiled providers and `@Provides`
  values): `onStart`, `onReady`, `onStop`, then disposal (`dispose` method name,
  `Symbol.asyncDispose`, `Symbol.dispose`). Transient instances belong to their consumer.
- **Lookup**: a key is a token, an alias or a provider class; a class that is not a registered key
  (e.g. an abstract base behind an alias, a class supplied as an external) falls back to its name,
  and the candidates of that name are ranked against the class:
  - **match**: the class of the slot's definition, or the class the slot was compiled or registered
    with (kept when `override()` replaces the binding with a value), is the key or a subclass of it,
    or the slot holds a value that is an instance of it (prototype chain only, never
    `Symbol.hasInstance`);
  - **mismatch**: the slot's class is known and belongs to another hierarchy: the candidate is
    excluded (a user class named `Container` never resolves the Znight `Container`);
  - **unknown**: no class is known (an unbound external, a `@Provides` value, a value that is not an
    instance of the key, e.g. an `implements` fake: types are structural): such candidates count
    only when no candidate matches.

  The unique remaining candidate wins, several are ZNIGHT008. Provider instances are never
  inspected, so the answer does not depend on whether a singleton was already created. **Impl.** a
  class without any provider that shares its name with a plugin value of unknown class (e.g. a user
  class `MessageBroker`) still receives that value when nothing matches.
  `get('Name')` accepts a unique display name (ZNIGHT008 otherwise). Lookups use `Map`s /
  `Object.hasOwn`, never plain-object indexing with user tokens. `token<T>(id)` declares a zero-cost
  `TypedToken<T>`.

### 8.2 Application & plugins

```ts
const app = await Application.create({ metadata, plugins: [HttpPlugin.configure({ port: 3000 })] })
await app.start()
```

```ts
interface ApplicationOptions {
  metadata: ZnightMetadata
  plugins?: Plugin[]
  providers?: Iterable<[ProviderKey, unknown]> | Record<Token, unknown> // application level
  overrides?: Iterable<[ProviderKey, unknown]> | Record<Token, unknown> // values or definitions
  logger?: CoreLogger // default: console logger
  shutdown?: {
    signals?: ('SIGINT' | 'SIGTERM' | ...)[] | false // default ['SIGINT', 'SIGTERM']
    timeoutMs?: number // global stop deadline, default 10 000; Infinity (or > 2^31 - 1) = none
    hookTimeoutMs?: number // per step, default 5 000; Infinity (or > 2^31 - 1) = none
    process?: ProcessLike // injectable for tests
  }
  init?: InitOptions // forwarded to container.init
  hot?: { dispose(cb: (data) => void | Promise<void>): void } // import.meta.hot: cb returns stop()
}
class Application {
  static create(options: ApplicationOptions): Promise<Application>
  start(): Promise<void>
  stop(): Promise<void>
  readonly state: 'created' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
  readonly container: Container
  readonly hooks: Hooks
  readonly metadata: ZnightMetadata
  readonly logger: CoreLogger // live delegating reference
  readonly plugins: readonly Plugin[]
  setLogger(logger: CoreLogger): void // e.g. replaced by ObservabilityPlugin
  getPlugin<P extends Plugin>(name: string): P | undefined
  get(key: ProviderKey): unknown
}
interface Plugin {
  readonly name: string // unique (duplicate → ZNIGHT004)
  register?(ctx: PluginContext): void | Promise<void> // provide externals (values or definitions)
  onBootstrap?(ctx: PluginContext): void | Promise<void> // after container.init (routes, consumers...)
  onStart?(ctx: PluginContext): void | Promise<void> // start ingress (listen, subscribe)
  onReady?(ctx: PluginContext): void | Promise<void>
  onStop?(ctx: PluginContext): void | Promise<void> // stop ingress and drain in-flight work
  onDispose?(ctx: PluginContext): void | Promise<void> // release infrastructure (connections, flush)
  initRoots?(context: PluginRootsContext): readonly ProviderKey[] // boot roots of restricted boots (§10)
}
interface PluginRootsContext {
  readonly metadata: ZnightMetadata // the metadata the application will be created with
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

Plugin options MAY be a function of the container (`PluginOptions<O> = O | ((c: Container) => O)`,
resolved with `resolveOptions`), e.g. `HttpPlugin.configure(c => ({ port: c.get(AppConfig).port }))`;
by convention it is evaluated in `onBootstrap` (exception: `ObservabilityPlugin`, §9.4).

`initRoots(context)` lists the providers (classes or tokens) a plugin needs at boot although the
metadata does not make them entry points: classes given in its options (`HttpPlugin`'s global
`guards`, `interceptors`, `exceptionMappers`, `OpenApiPlugin`'s `guards`), or providers it derives
from its own metadata section. It is read by tools that restrict the boot (`init: { only }`), such as
`TestApp` (§10), which create these providers at boot with their dependencies, since an async
factory cannot run on demand. The application never calls it. It is called before the application
is created (before `register`), possibly several times: it MUST be cheap and side-effect free, and
SHOULD NOT throw (invalid options are reported by `onBootstrap`). Options given as a function of
the container cannot be read yet: it returns what is known (`[]`).

Sequence:

1. `create()`: container ← metadata; built-ins; `providers`; plugins `register` (in order);
   `overrides`; `container.init()`; plugins `onBootstrap`. Failure → rollback through the shutdown
   routine, then rethrow.
2. `start()`: signal handlers installed (so Ctrl+C during a slow boot shuts down gracefully);
   providers `onStart` (resolution order) → plugins `onStart` → providers `onReady` → plugins
   `onReady`. `state = 'ready'`. A failure stops what was started, disposes, and rethrows.
3. `stop()` (idempotent; waits for an in-progress `start()`, except when called from a start hook,
   below): `state = 'stopping'` → plugins `onStop` (reverse) → providers `onStop` (only those whose
   `onStart` ran) + disposal (always, reverse resolution order) → plugins `onDispose` (reverse) →
   `state = 'stopped'` (also when `stop()` rejects). Every step is attempted with `hookTimeoutMs`
   inside the global `timeoutMs` deadline (both MUST be non-negative numbers, ZNIGHT005 otherwise;
   `Infinity`, or any budget above 2^31 − 1 ms — the range of timers —, means no limit and arms no
   timer); errors are aggregated (`ZnightAggregateError`, ZNIGHT021). Signal listeners are removed.
   `Application stopped` is logged once, at `info` after a signal, at `debug` otherwise. Only the
   signal path sets `process.exitCode` (1 on failure) and a second signal forces exit (130).

**Stop requested by a start hook.** Each start hook (`onStart`/`onReady` of a provider or plugin)
runs in an async context (`AsyncLocalStorage`) carrying a marker of its own. A `stop()` called from
that context (the hook itself, awaited or not, or work it awaits) MUST NOT wait for the start, which
is waiting for that hook: the shutdown runs right away, stopping what completed its `onStart`; the
remaining start hooks are skipped and `start()` resolves once the application is `stopped` (it
rejects with the hook's error if the hook throws afterwards). A `stop()` already waiting for the
start (a signal during the boot) is released at the same time. A `stop()` from work an _earlier_
hook left running still waits for the start.

**HMR.** With `hot` (`import.meta.hot`), `create()` registers a dispose callback that returns the
`stop()` promise, so the HMR runtime (Vite's module runner, Bun) waits for the old application to
release its ports and consumers before it evaluates the new module; a failed stop is logged
(`Failed to stop the application`), never rejected to the HMR runtime.

Plugin hook errors that are not `ZnightError`s are wrapped in ZNIGHT021 naming the plugin and the
hook; `ZnightError`s (e.g. ZNIGHT006 from config) pass through unchanged. **Impl.** singletons
created on demand after `start()` receive neither `onStart` nor `onReady`; there is no timeout on
async factories during `init()` nor on start hooks.

### 8.3 Hooks

```ts
interface ZnightHooks {
  'http:request': HttpRequestEvent // produced by @znight/http
  'messaging:message': MessageDeliveryEvent // produced by @znight/messaging (one delivery)
  'messaging:publish': MessagePublishEvent // produced by @znight/messaging (MessageBroker.publish)
  'schedule:run': ScheduledRunEvent // produced by @znight/schedule (one occurrence of a job)
} // augmentable by third-party packages
class Hooks {
  on<K>(name: K, listener: (event) => unknown): () => void
  emit<K>(name: K, event): void
  wrap<K>(name: K, wrapper: (event, next: () => Promise<unknown>) => Promise<unknown>): () => void
  run<K, R>(name: K, event, fn: () => Promise<R>): Promise<R> // first registered = outermost
  hasListeners(name): boolean
  hasWrappers(name): boolean
}
```

- The four hooks and their event types live in `@znight/core`, so producers and observers share
  them without depending on each other. Event shapes:
  - `HttpRequestEvent`: `method`, `path`, `route` (pattern, `undefined` when unmatched),
    `requestId`, `headers`, `context` (`HttpContext`), `startTime`, `responseHeaders` (mutable),
    `status?`/`error?` (set before `run` resolves);
  - `MessageDeliveryEvent`: `queue`, `type`, `messageId`, `attempt`, `headers`, `consumer`,
    `handler`, `message` (`InboundMessage`), `startTime`, `outcome?` (`ack` / `retry` /
    `dead-letter`), `error?`;
  - `MessagePublishEvent`: `queue`, `type`, `messageId`, `headers` (mutable until `next()`: wrappers
    add trace context), `startTime`, `error?`;
  - `ScheduledRunEvent`: `job`, `kind` (`cron` / `interval` / `timeout`), `host` and `method`
    (`undefined` for dynamic jobs), `runId`, `trigger` (`schedule` / `start` / `manual` / `queued`),
    `scheduledAt` (epoch ms of the occurrence, scheduler clock), `context` (the `JobContext`,
    `undefined` when the run did not execute), `startTime`, `outcome?` (`completed` / `failed` /
    `skipped` / `not-acquired`), `error?`, `aborted?` (`timeout` / `lock-lost` / `removed` /
    `shutdown`). Executed runs are wrapped with `run`, then emitted; occurrences that do not execute
    (skipped, lock not acquired, lock store failure) are only emitted.
- Listeners are called synchronously in registration order; a failing listener is logged and never
  affects the emitter. Producers call `run` when there are wrappers and `emit` after it when there
  are listeners.
- `run()` resolves with `fn`'s result; values returned by wrappers are ignored; when a wrapper does
  not call `next()`, the operation does not run and `run()` resolves `undefined` (a `schedule:run`
  wrapper vetoes the run that way: outcome `skipped`). The producer sets the outcome of a vetoed
  run once `run()` resolved: inside the wrappers, after `next()` returned, `outcome` is still
  `undefined` for a veto (or for a wrapper that threw before the job), and observers read it as
  `skipped` (`failed` when `next()` rejected).
- Registration is copy-on-write: emitting allocates nothing.

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

Interceptors are applied as own-property wrappers on the instance (no Proxy; `applyInterceptors` /
`interceptMethod`): `#private` fields keep working and self-invocation (`this.method()`) is
intercepted. The top-most decorator is the outermost interceptor. Interceptors MUST follow
`isAsync` (never turn a sync method into an async one); in development (`NODE_ENV !==
'production'`), an interceptor returning a thenable for a sync method throws a ZNIGHT005
`ZnightError` naming the interceptor.

### 8.5 Errors and logging

- `ZnightError extends Error { code; hints }`; catalogue `ErrorCode` (`as const`) +
  `ERROR_DESCRIPTIONS`.
- `ZnightAggregateError` is a `ZnightError` with `.errors` (not `instanceof AggregateError`), so
  every runtime error carries a code. `InstantiationError` (ZNIGHT015) carries `token`, `path`,
  `source` and `cause`. Cleanup errors are attached to the original error and read with
  `getSuppressedErrors(error)`.
- `CoreLogger` (`debug`/`info`/`warn`/`error` with an optional context object), `createConsoleLogger`,
  `silentLogger`, `DelegatingLogger`.

## 9. Feature runtime contracts

Common rules: each feature plugin is created with `XxxPlugin.configure(options)`, has a fixed `name`
(`http`, `messaging`, `config`, `observability`, `openapi`, `schedule`), and provides the externals
declared in its manifest (§7) during `register`. `HttpPlugin`, `MessagingPlugin`,
`ObservabilityPlugin`, `OpenApiPlugin` and `SchedulePlugin` also accept a function of the container
(§8.2); `ConfigPlugin` only takes an object, since it loads the configuration in `register`, before
any provider exists.

### 9.1 HTTP (`@znight/http`)

```ts
interface HttpMetadata {
  controllers: HttpControllerDefinition[]
  // route decorator groups (RFC 0001), only when some group needs it: required, several keys, or a
  // name different from its key; groups and keys sorted. A key listed nowhere is its own group.
  groups?: Record<string, { keys: string[]; required: boolean }>
}
interface HttpControllerDefinition {
  token
  basePath // normalised, '/' when absent
  guards: Token[]
  interceptors: Token[]
  meta: Record<string, unknown> // createRouteDecorator on the class: the default decision of each group
  routes: HttpRouteDefinition[]
}
interface HttpRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ALL'
  path: string
  fullPath: string // joinPaths(basePath, path), without the plugin prefix
  handler: string
  status?: number // @HttpCode
  headers?: Record<string, string> // @Header, lower-case names
  meta: Record<string, unknown> // merged over the controller meta at runtime, one decision per group (the route's wins)
  guards: Token[]
  interceptors: Token[]
  params: {
    index
    source:
      | 'param'
      | 'query'
      | 'body'
      | 'headers'
      | 'request'
      | 'response'
      | 'context'
      | 'file'
      | 'files'
      | 'cookie'
      | 'signedCookie'
    name? // param / query key / header name / multipart field (file, files) / cookie name
    type? // readable form, only for coerced values
    optional?
    schema?: boolean
  }[] // informational: extraction happens in invoke
  bodyLimit?: number // @BodyLimit (route, else controller), bytes; Infinity = no limit
  uploads?: {
    // one per @UploadedFile / @UploadedFiles parameter
    field?: string // absent: files of every field
    multiple?: boolean // @UploadedFiles
    required?: boolean // informational: presence is checked by invoke
    maxSize?: number // bytes, default: plugin uploads.maxFileSize
    maxFiles?: number // @UploadedFiles, default: plugin uploads.maxFiles
    mimeTypes?: string[] // 'image/png', 'image/*'
  }[]
  rawResponse?: boolean // @Res()
  sse?: { heartbeat?: number; retry?: number; maxDuration?: number } // @Sse (GET); heartbeat 0: none
  invoke: (controller: any, ctx: HttpContext) => unknown
}
```

`invoke` extracts, coerces and validates every argument with the helpers exported by `@znight/http`
(`coerce.string|number|integer|boolean|bigint|date|enum|array|optional`, failures → 400; numbers are
matched in linear time; `date` accepts an ISO 8601 date (UTC midnight), an ISO 8601 date-time
**with** an offset (`Z`, `+02:00`, `+0200`) or an integer millisecond timestamp, checks the calendar
(`2024-02-30` → 400) and rejects a date-time without offset, which would depend on the server time
zone; `validate(schema, value, location)` with any Standard Schema, `await`ed, so the arrow is
`async` only when a schema is used). `@Validate(S)` without `@Body()` generates `await validate(S,
await ctx.parseBody(), 'body')`. Upload parameters read `ctx.files` through the `uploads` helper,
imported by the generated module only when a route uses it: `@UploadedFile('avatar') avatar: File` →
`uploads.file(ctx, 'avatar')` (400 `Missing file "avatar"` when absent; `optionalFile` for an
optional parameter, `files` / `optionalFiles` for `@UploadedFiles`; `undefined` field = every
field). `@Body()` on an upload route receives the text fields. Cookie parameters read
`ctx.cookies['name']` (`@Cookie`) or `ctx.signedCookie('name')` (`@SignedCookie`) with the label
`cookie "name"` (`coerce.X`, `coerce.optional` or `await validate(S, ..., 'cookie "name"')`), the
whole record `ctx.cookies` (`validate(S, ctx.cookies, 'cookies')` with a schema). Unused `ctx` is
omitted.

Pipeline (normative), per request — matched or not:
`container.runInScope({ HttpContext, RequestId }) → hooks.run('http:request', event, () =>
[CORS preflight: answered here] → global guards → controller guards → route guards → body parsing (routes with a @Body() or upload
parameter; multipart bodies are parsed as they stream in, upload rules enforced on the fly) →
global/controller/route interceptors (outermost first) → invoke (extract → coerce → validate →
handler) → serialise (files, event streams opened))`. `@Validate(S)` alone parses the body in
`invoke`. Exceptions are mapped to a response inside `hooks.run` and `event.status` /
`event.error` are set before it resolves. The response is completed last: `event.responseHeaders`
(each only when absent), the cookies appended to `set-cookie` (below), then the request id, the
CORS headers and the security headers, each only when absent (below); `@Res()` raw replies get
none of them. The
request scope (request-scoped instances) and the in-flight count last until a streamed response
body (a file or `Blob` included) has been fully read or cancelled by the adapter; stream sources are
read in the async context of the handler (request-scoped providers and tracing keep working).

- Path grammar: static segments, `:name` params, trailing `*` wildcard (`ctx.params['*']`); anything
  else ZNIGHT007 (at build time, and at boot for hand-written metadata). Routing happens on the
  **raw** (percent-encoded) request target: dot segments are not resolved (`/files/a/../b` gives
  `ctx.params['*'] = 'a/../b'`); when the native router of an adapter misses a request because it
  routes a normalised path, the plugin routes the raw path itself through its route table.
  Parameters are extracted and percent-decoded by Znight from the raw path on every adapter
  (malformed encoding → 400); the most specific route wins (static > param > wildcard).
  **Impl.** deviation: the Hono adapter on Bun only receives the WHATWG-normalised URL from
  `Bun.serve()` (`/files/%2e%2e/x` is routed as `/x`). Trailing-slash policy `strict` (default) /
  `ignore` / `redirect` (308) applied on every adapter; the redirect `location` always stays on the
  same origin (a backslash, a control character or a space of the raw path is percent-encoded and
  leading slashes are collapsed: `/\evil.com/` → `/%5Cevil.com`).
- `HEAD` is served for every `GET` route unless a `@Head` route exists (the Fastify adapter disables
  `exposeHeadRoutes`). `@All` registers the route for GET, HEAD, POST, PUT, PATCH, DELETE and
  OPTIONS, only for methods without an explicit route on the same path. Unknown path → 404; known
  path, other method → 405 with `allow`; unmatched `OPTIONS` → 204 with `allow`. Both `allow`
  headers list the same methods, `OPTIONS` included (answered automatically, RFC 9110). 404/405 go
  through the hooks and the exception mappers.
- Query parsing is done by Znight from the URL (`Record<string, string | string[]>`); coercion to
  `T[]` accepts a single value. Bodies are parsed by Znight: JSON, text, urlencoded and multipart →
  a prototype-less record of the text fields (repeated names → arrays; the files of a multipart body
  go to `ctx.files`, by field, in body order), otherwise bytes; up to the body limit of the route
  (413), `content-encoding` other than identity → 415. Routes without `@Body()` nor upload parameters
  read it lazily (`ctx.parseBody()`, `ctx.rawBody()`, or `ctx.bodyStream()`: a Web stream enforcing
  the limit, exclusive with the other two). Whether a request has a body is decided by its
  `content-length` / `transfer-encoding` headers first (`content-length: 0`, or no framing header on
  an HTTP/1.1 connection: no body), the adapter's `hasBody()` only for in-memory requests without
  them. Once the request is over, a body stream (or multipart stream) it did not read to the end is
  cancelled (`releaseBody`): the rest of the body is discarded and the keep-alive connection serves
  the next request.
- Body limit of a route: `@BodyLimit` (route > controller) when present; otherwise the plugin
  `bodyLimit` for ordinary routes and, for upload routes, `bodyLimit` + Σ `maxSize × maxFiles` of
  their upload parameters.
- Uploads (`multipart/form-data`, RFC 7578): Znight's own streaming parser, shared by every adapter
  (not `Request.formData()`). On upload routes, files are accepted only in the declared fields
  (400 otherwise), each `maxSize` / `maxFiles` (413), `mimeTypes` (415, compared with the declared
  type) is enforced while reading; a second file for `@UploadedFile` → 400; non-multipart non-empty
  bodies → 415. A 400 about a named file field (unexpected field, missing file, text value in a file
  field, second single file) carries `details: [{ path: <field>, message }]`, the issue shape of
  `ValidationException`; the 413 of a file carries `{ field, maxSize }` or `{ field, maxFiles }`, the
  415 of a file `{ field, type, accepted }`. Other routes accept files of any field within the plugin
  `uploads` limits. Plugin-wide limits `uploads: { maxFileSize (10 MiB), maxFiles (10), maxParts
  (1000), maxFieldSize (1 MiB) }`; part headers ≤ 16 KiB. Errors raised while the body is still
  being read carry `connection: close`. Files are standard `File` objects held in memory.
- Files out: `HttpResponse.file(path | file: URL | Blob, { filename, contentType, disposition, root,
  dotfiles })` (file-backed `Blob`s via `fs.openAsBlob()`; `root` confines the path, links
  included, dotfiles denied by default → 404; `Content-Length`/`Content-Type`/`Last-Modified`/strong
  `ETag`; conditional requests 304/412; a single `bytes` range 206/416, other ranges → 200; RFC 6266
  `Content-Disposition`) and `HttpResponse.stream(source, { contentType, filename, disposition })`
  (Web stream, Node.js `Readable` or async iterable; pull-based, cancelled when the client
  disconnects; chunked). A file (or any `Blob`) body is sent as a tracked stream like any other
  stream body: the request scope and the in-flight count last until it has been sent or the client
  went away, so a request-scoped provider may own the file. Details:
  [packages/http/README.md#files](../../packages/http/README.md#files).
- Status precedence: `@HttpCode` > `HttpResponse.status` > default (201 for POST, 200 otherwise);
  `undefined` return → empty body (204 unless POST or `@HttpCode`). Objects → JSON, strings → text,
  `Uint8Array`/`ArrayBuffer`/views → octet-stream, `ReadableStream`/Node.js `Readable` → streamed
  octet-stream (string, `ArrayBuffer` and view chunks converted to bytes), `Blob`/`File` → its type
  and size, Web `Response` → sent as is.
- Errors: `HttpException(status, message?, details?, { headers, cause })` and subclasses render
  `{ statusCode, error, message, details? }`; schema failures → 400 (`ValidationException`) with
  `details: [{ path, message }]`, the shape also used by the upload 400s about a field; other errors → `{ statusCode: 500, error: 'Internal Server Error' }`
  (message only with `exposeErrors: true`), sent to hooks and the logger. An exception mapper
  returning an `HttpResponse` without status keeps the error's status.
- Response headers are validated by the plugin (after the handler, and after the headers added by
  hook wrappers), never by the adapter: a name or value that cannot be sent (CR/LF, a character
  above `\xff`) gives the same generic 500 on every adapter, the body is cancelled and the error
  logged; adapters receive only sendable headers.
- Handlers receive the schema **output** (defaults, transforms, stripped keys).
- Request ids: the `requestIdHeader` (default `x-request-id`) is reused when the client sends a
  valid one (≤ 128 characters of `[A-Za-z0-9_\-.:@/+=]`) and echoed on every response; `false` always
  generates (`generateRequestId`, default `crypto.randomUUID()`) and never echoes.
- **Route decisions** (RFC 0001). The effective metadata of a route is the controller's entries whose
  group the route does not decide, then the route's entries (`groupOf(key)` = the group listing the
  key in `groups`, else the key itself; without groups this is the former key-by-key merge). It is
  computed once at boot and frozen; `ctx.route.meta`, `decorator.get(ctx)` and `HttpPlugin.routes`
  read it. `httpMetadata()` validates `groups` (an object of `{ keys, required }`: non-empty unique
  string keys, a boolean, a key in at most one group; a group name follows the group grammar of §5
  unless the group is named after its single key) and hand-written metadata with two keys of one
  group on the same target: ZNIGHT007. Plugin route `meta` entries follow the same naming rule.
- **Boot check of decisions** (normative). In `onBootstrap`, once the routes are registered, every
  controller route (HEAD and trailing-slash variants ignored) and every plugin route is checked:
  - its **chain classes** are the classes of its guards: a global guard given as a class, or the
    `constructor` of a global guard instance; controller and route guards through
    `metadata.providers[token].class` (the compiled class: a guard replaced through `overrides` keeps
    its declaration); a guard without class (built by a factory) enforces nothing. The static
    `enforces` of each chain class MUST be an array of `{ key: string, group: string, required:
    boolean }` (ZNIGHT005 naming the guard), consistent with `groups` (ZNIGHT005);
  - the **guard classes of the application** are the classes of `metadata.providers` with a
    `canActivate()` method on their prototype, in a chain or not: the shape of their `enforces` is
    validated the same way (ZNIGHT005), and their groups only become known (a guard registered
    nowhere neither declares its groups nor makes them required), so that a decision whose guard was
    forgotten in every chain (a second entrypoint, a worker, a test) is reported instead of being
    silently unenforced;
  - `enforced(route)` = the groups listed by its chain classes; `known` = the groups enforced by any
    chain or by any guard class of the application; `required` = the required groups of `groups`,
    plus the required groups declared by the `enforces` of chain classes and by plugin route `meta`
    entries (a group can be known at boot only, e.g. an auth package shared between services);
    `decided(route)` = the groups of its effective metadata;
  - problems: `required − decided(route)` (no decision) and `(decided(route) ∩ (required ∪ known)) −
    enforced(route)` (a decision no guard of its chain enforces, a non-required group such as
    `@RateLimit()` included). With `enforcement: 'error'` (default) every problem goes into **one**
    ZNIGHT023 `ZnightError` listing the routes by group, with hints (the plugin of a plugin route,
    the guard classes of the application enforcing the group, `enforcement: 'warn'` for tests);
    with `'warn'`, one `logger.warn` per group.
- **CORS** (option `cors`, off by default; policy in `cors.ts`, identical on every adapter). Options
  `{ origin, credentials?, methods?, allowHeaders?, exposeHeaders?, maxAge? }` are validated at boot
  (ZNIGHT005): `origin` is required (`'*'`, an origin, a `RegExp`, a list of them, or a possibly
  async function); a string other than `'*'` MUST equal `new URL(value).origin` with `http:` or
  `https:` (no path, trailing slash or default port); `'null'` is refused; a `RegExp` is anchored
  with `^` and `$` around every alternative and has no `g` / `y` flag; a policy is a **wildcard**
  policy when `'*'` is the origin or one of the origins of a list (`['*']` behaves like `'*'`);
  `credentials: true` is refused with a wildcard policy, with `allowHeaders: '*'` and with `'*'` in
  the `methods`, `allowHeaders` and `exposeHeaders` lists (on credentialed requests browsers read
  it as a method or header named `*`); methods and header names are HTTP tokens; `maxAge` is an
  integer in 0..86400 (default 600); `exposeHeaders` defaults to the request id header.
  - The origin decision is made once per request carrying `origin`, before the hook runs: exact
    match, anchored `RegExp` test, or the awaited function (a throw or rejection denies, logged at
    `error`).
  - A **preflight** (`OPTIONS` with `origin` and `access-control-request-method`) is answered inside
    `hooks.run('http:request')` and never runs guards, interceptors or handlers, even when an
    `@Options` or `@All` route matches: a path without route → 404 and a denied origin → 403 `CORS
    origin not allowed` (both without CORS headers); otherwise 204 with
    `access-control-allow-origin` (`*` for the wildcard, else the request origin),
    `access-control-allow-credentials` (with `credentials`), `access-control-allow-methods`
    (`methods`, else the methods of `allow`), `access-control-allow-headers` (`allowHeaders`, else
    the requested list when it is a valid token list; `*`, alone or listed, gets `, authorization`
    appended when the browser asks for `authorization`, which `*` never covers),
    `access-control-max-age`, `allow` and
    `vary: origin, access-control-request-method, access-control-request-headers`. `event.route`
    is `undefined` for a preflight.
  - Every other reply to an allowed origin (2xx, guard 401/403, 404, 405, 413, 500, automatic
    `OPTIONS`, redirects) gets `access-control-allow-origin`, `access-control-allow-credentials` and
    `access-control-expose-headers` unless already set, and `vary: origin` is merged, token by
    token, into every reply. With a wildcard policy every reply that is not a preflight gets
    `access-control-allow-origin: *` (and `access-control-expose-headers`), with or without an
    `origin` request header, and no `vary: origin`: the reply does not depend on the request, so a
    cached reply serves CORS and non-CORS requests alike. A denied origin on a request that is not
    a preflight is served normally, without CORS headers. `@Res()` raw replies are not touched.
- **Security headers** (option `securityHeaders`, default `true`): `content-security-policy:
  default-src 'none'; frame-ancestors 'none'`, `x-frame-options: DENY`, `x-content-type-options:
  nosniff`, `referrer-policy: no-referrer`; opt-in `strict-transport-security` (`true`:
  `max-age=31536000; includeSubDomains`; `preload` needs `includeSubDomains` and a `maxAge` of at
  least a year), `cross-origin-resource-policy` and `cache-control`. An object merges over the
  defaults, `false` disables them. Values are validated at boot (ZNIGHT005; `referrerPolicy` against
  the standard tokens) and computed once into a frozen record, added last to every reply that does
  not set them (`@Res()` raw replies excepted), so they lose to the handler, an interceptor, an
  exception or a hook wrapper.
- **Trusted proxies** (option `trustProxy`, default `false`). `false`: `ctx.ip` is the adapter's
  `request.ip` (Fastify and Express apply their own proxy settings) and `ctx.protocol` comes from
  `request.encrypted`. A number (an integer ≥ 1) or a list of IPv4 / IPv6 addresses, CIDR ranges and
  the aliases `loopback` (127.0.0.0/8, ::1/128), `private` (10.0.0.0/8, 172.16.0.0/12,
  192.168.0.0/16, fc00::/7) and `linklocal` (169.254.0.0/16, fe80::/10) walk the list
  `[remoteAddress ?? ip, ...x-forwarded-for from right to left]`: with a number, the client is the
  entry at that index (the leftmost when the list is shorter); with a list, the walk continues while
  addresses are trusted, and the first untrusted one is the client (the leftmost when all are
  trusted). IPv4-mapped IPv6 addresses are normalised; a malformed entry (`ip:port` included) stops
  the walk at the last valid address. When the socket peer is trusted, `ctx.protocol` is the
  leftmost `x-forwarded-proto` value when it is `http` or `https`; otherwise the protocol of the
  connection. `true`, a negative or fractional number and an invalid CIDR are ZNIGHT005. The
  `Forwarded` header is not read.
- **Plugin routes** (`PluginHttpRoutes`). A plugin implementing `httpRoutes({ prefix, container }):
  readonly PluginRoute[]` has it called once in `HttpPlugin.onBootstrap`, after `container.init()`
  and after the compiled routes, whatever the plugin order. A `PluginRoute` is `{ method, path,
  name, handler: (ctx) => unknown, meta?: RouteMetaEntry[], guards?: GuardRef[] }`: `path` follows
  the controller grammar, relative to the prefix; `meta` entries (`decorator.meta(value)`, one per
  group) are the route metadata. The routes are registered through `adapter.registerRoute` in the
  same pipeline: hook, request scope, global guards, then the route's `guards`, the handler and the
  exception mappers; global interceptors do not wrap them; the body is read lazily; `GET` answers
  `HEAD`. An invalid route or a collision with another route is ZNIGHT007 naming the plugin. The
  plugin name is `ctx.route.controller` and the `source` of the route summary.
- **Cookies** (RFC 0006; `cookies.ts` is import-free). Request: the `cookie` header is split on `;`
  only, pairs trimmed, quoted values unquoted, `%` sequences decoded (malformed: kept raw); pairs
  without `=` or with an empty name are ignored; the first occurrence of a name wins; repeated
  `cookie` fields are joined with `; `. `ctx.cookies` is a frozen prototype-less record parsed on
  first access, in linear time (each character is scanned at most twice, even for a header made of
  `;` without `=`). Response: `ctx.setCookie(name, value, options?)` /
  `ctx.clearCookie(name, options?)` validate everything at call time (`TypeError` / `RangeError`) and
  feed the context jar, sent with **every** reply of the request (errors, guard rejections, redirects,
  automatic `OPTIONS`, and the fallback reply of an `http:request` hook wrapper that failed before
  `next()`, which goes through the same header and cookie checks, so an exception mapper's
  `HttpResponse` keeps its cookies); `HttpResponse.withCookie()` / `withoutCookie()` validate what
  does not depend on the plugin at call time and the rest when the reply is serialised (a violation:
  a plain 500 logged as `Invalid cookie "x": …`). Serialisation (RFC 6265bis): name an RFC 9110
  token, value canonically percent-encoded (`encode(decode(v)) === v`), `name=value` ≤ 4096 bytes
  after signing, `Domain` / `Path` ≤ 1024 bytes; `expires` in the years 1601 to 9999 (other years
  are a `TypeError` suggesting `maxAge`: browsers ignore them); `SameSite=None` and `Partitioned`
  require `Secure`; the prefixes `__Secure-`, `__Host-` (`Secure`, `Path=/`, no `Domain`),
  `__Http-` and `__Host-Http-` (also `HttpOnly`) are enforced, case-insensitively. Defaults
  `Path=/; Secure; HttpOnly; SameSite=Lax`, host-only, merged with `cookies.defaults`; `domain:
  null` on a cookie makes it host-only whatever the defaults, and a `__Host-` cookie never takes the
  default `domain` nor `path` (its own options are still checked: an explicit incompatible `domain`
  or `path` throws). A reply carries one jar keyed by (name, domain, path; a `null` domain is
  host-only): a later cookie of the same key replaces the earlier one in place, the `HttpResponse`
  jar wins over the context jar, and `set-cookie` holds the raw values first (`@Header`,
  `ctx.setHeader()` / `appendHeader()`, `HttpResponse` headers, a Web `Response`), then the jar, one
  field line per cookie on every adapter. Cookies set on the native response by middleware before
  the Znight route (Express `res.cookie()`, Fastify hooks `reply.header('set-cookie', …)`, Hono
  `setCookie(c, …)`) are kept before the reply's own on every adapter, event streams included. Once
  the headers are sent (a running event stream), `setCookie()` / `clearCookie()` throw. Signed
  cookies: `<encoded value>.<base64url(HMAC-SHA256(secret, "<name>=<encoded value>"))>`, verified
  in constant time against every secret of `cookies.secrets` (each ≥ 32 bytes, no duplicate; the
  first signs); an invalid signature makes the cookie absent. A compiled route reading
  `@SignedCookie` without secrets fails the boot (ZNIGHT006); `ctx.signedCookie()` and
  `{ signed: true }` without secrets throw. `plugin.signCookie(name, value)` returns the signed
  wire value.
- **Server-Sent Events** (RFC 0006; `sse.ts`). An `@Sse` route's awaited result that is an
  `AsyncIterable`, a non-string `Iterable` or a `ReadableStream` (of `SseEvent` objects, or
  `Uint8Array` chunks written as is) is served as an event stream; an `HttpResponse` or a Web
  `Response` is sent as usual; anything else is a logged 500. `HttpResponse.sse(source, options?)`
  serves one from any route and method (200 by default, `@HttpCode` / `withStatus()` honoured
  outside `@Sse`; its options win over the route's). Effective options: the `HttpResponse.sse()`
  options, then the route's `sse`, then the plugin `sse` (`heartbeat` 8 000, no `retry`).
  Headers: `cache-control: no-cache, no-transform` and `x-accel-buffering: no` first (overridable),
  `content-type: text/event-stream; charset=utf-8` last; never `content-length`. Each event is one
  chunk (WHATWG framing: comment lines, `id`, `event`, `retry`, one `data:` line per line of the
  data, CR / LF / CRLF split; non-string data through `JSON.stringify`; `event` without `data` gets
  an empty `data:`; an invalid item is a `TypeError` that stops the source, and so is an `SseEvent`
  that follows raw bytes not ending at an event boundary, which it would merge into). Lifecycle
  (normative): the first chunk (`retry: N`, else the comment `:`) is written without reading the
  source; the source is pulled once per chunk the client reads (no read-ahead); a heartbeat comment
  is sent after `heartbeat` ms without an event, never inside raw bytes that do not end at an event
  boundary (the boundary is tracked across chunks, a CRLF split between two chunks included); a
  source error ends the response cleanly and is logged; a client disconnect aborts `ctx.signal`
  (`client`) and stops the source (`return()` / `cancel()`), the scope closing once it stopped or
  after 5 s with a warning; `maxDuration` and shutdown close gracefully: `ctx.signal` aborts
  (`expired` / `shutdown`), the source is still read for `sse.shutdownGraceMs` (1 000), then
  `retry: R` with R drawn in `[r, 2r]` (r = the `retry` option, else 3 000) ends the stream, written
  only at an event boundary (after an unterminated raw event the stream ends without it); `HEAD`
  sends the headers and never reads the source. Every timer is capped at 2^31 − 1 ms (the options
  are validated against it; the session caps its delays as a backstop). `http:request` resolves when
  the stream opens; the request scope and the in-flight count last until it ends. Guards run once,
  before the stream; exception mappers only apply before it starts. `plugin.streams` counts the open
  streams. `EventChannel` (bounded `capacity`, `overflow` `drop-oldest` / `drop-newest` / `close`,
  `signal`) bridges push sources; `encodeSseEvent()` and `parseSseStream()` (WHATWG parsing) are
  exported.
- **`ctx.signal`** exists on every route (created on first access): it aborts when the client
  disconnects before the response was written (`AdapterRequest.onAbort`), when the response body is
  cancelled, or when the server closes an event stream; never after a normal completion. Its reason
  is a `RequestAbortedError` (`name: 'AbortError'`, `kind: 'client' | 'shutdown' | 'expired'`).
  Ordinary in-flight requests are not aborted on shutdown: they drain.
- `HttpPlugin.configure({ adapter, port, host, prefix, guards, interceptors, exceptionMappers,
  trailingSlash, exposeErrors, bodyLimit, uploads, requestIdHeader, generateRequestId,
  drainTimeoutMs, cors, securityHeaders, trustProxy, enforcement, cookies, sse })` (defaults: built-in
  `nodeAdapter()`, `3000`, `0.0.0.0`, `strict`, `false`, 1 MiB, the upload limits above,
  `x-request-id`, 4 000 ms, no CORS, `true`, `false`, `'error'`, no secrets and the secure cookie
  defaults, `{ heartbeat: 8000, shutdownGraceMs: 1000 }`); `cookies` is `{ secrets?, defaults? }`,
  `sse` is `{ heartbeat?, retry?, shutdownGraceMs? }` (`heartbeat` from 1 000 to 2^31 − 1 ms or
  `false`, `shutdownGraceMs` from 0 to 2^31 − 1 ms and < `drainTimeoutMs`; invalid values and
  unknown keys: ZNIGHT005); class refs are resolved with `container.tokenOf`.
  The options are resolved once per application. The instance exposes
  `inject`, `injectStream`, `injectSse`, `streams`, `signCookie`, `address`, `adapter`, `inflight`,
  `prefix` (the resolved prefix, `''` or `/api`:
  readable at any time with object options, from the `onBootstrap` of any plugin with a function of
  the container), `routes` (frozen `HttpRouteSummary[]`: `{ method, path, controller, handler,
  source, meta, guards }`, `path` with the prefix, `source` `'controller'` or the name of the plugin,
  `meta` the effective metadata, `guards` the display names of the chain in order: global,
  controller, route; HEAD and trailing-slash variants included) and `initRoots()` (the classes of
  its `guards`, `interceptors` and `exceptionMappers` options, `[]` when the options are a function
  of the container: §8.2, §10).
  A plugin instance serves one application at a time (it can serve another one once the previous
  application stopped; registering it in a second running application is ZNIGHT004 "Call
  HttpPlugin.configure() once per application"); an adapter instance serves a single application
  (bootstrapping it again is ZNIGHT021: create adapters per application, e.g.
  `HttpPlugin.configure(() => ({ adapter: fastifyAdapter() }))`).
- Lifecycle: `register` declares the request-scoped externals; `onBootstrap` resolves options,
  registers the compiled routes, then the plugin routes, and runs the decision check (ZNIGHT007 /
  ZNIGHT001 / ZNIGHT006 / ZNIGHT023 at boot); `onStart` listens; `onStop` drains: marks the pipeline
  draining, closes the open event streams gracefully (`shutdown`: their sources get
  `sse.shutdownGraceMs`, then a jittered `retry`; an event stream requested while draining is served
  with its signal already aborted), stops accepting connections, closes idle ones, answers with
  `connection: close`, waits for in-flight requests (streamed and file responses included) up to
  `drainTimeoutMs` (keep `sse.shutdownGraceMs` < `drainTimeoutMs` <
  `hookTimeoutMs`; `Infinity`: no limit of its own, no timer; a finite value is capped at the timer
  range, 2^31 − 1 ms), then force-closes; `onDispose` closes the adapter.

```ts
interface HttpAdapter {
  name: string // ctx.adapter
  registerRoute(route: { method; path: RoutePath; handler: AdapterHandler }): void // ALL expanded, HEAD added
  setFallbackHandler(handler: FallbackHandler): void // unmatched requests and framework errors
  listen(port: number, host: string): Promise<HttpServerAddress> // port 0 = free port
  close(options?: { force?: boolean }): Promise<void> // graceful drain, or destroy connections
  inject(request: InjectRequest): Promise<InjectResponse> // in-memory, same pipeline; rejects an event stream
  injectStream?(request: InjectStreamRequest): Promise<InjectStreamResponse> // resolves at the headers (the 4 built-in adapters)
}
```

```ts
interface AdapterRequest {
  method
  url
  headers
  ip // the client address the adapter knows (socket, or its framework's proxy settings)
  remoteAddress? // the socket peer, never from headers: the start of the trustProxy walk
  encrypted? // TLS connection: ctx.protocol without a trusted proxy
  raw
  rawResponse
  readBody(limit: number): Promise<Uint8Array> // once; 413 past the limit (content-length first)
  streamBody?(limit: number): ReadableStream<Uint8Array> // pull-based, 413 past the limit, 400 on abort
  hasBody?(): boolean // asked only without content-length / transfer-encoding; false over HTTP/1.1
  rawStatus?(): number | undefined // status written through @Res()
  onAbort?(listener: () => void): void // client gone before the response was written; never after a complete one
}
type ReplyBody = Uint8Array | ReadableStream<Uint8Array> | Blob | null // the plugin sends no Blob
interface AdapterReply {
  status
  headers // lower-case names, validated: every name and value can be sent
  body: ReplyBody // bytes, a stream (files too) or null
  blob?: Blob // the file `body` streams, for adapters able to send it natively
  raw?: boolean
  eventStream?: boolean // a streamed text/event-stream body: headers at once, no idle timeout, no buffering, no compression
}
interface InjectRequest {
  method
  url
  headers?
  body?
  query?
  cookies? // name → value, sent in a cookie header after headers.cookie
  signedCookies? // signed by HttpPlugin (first secret) and merged into cookies; never seen by adapters
} // body: string | bytes | FormData | Blob | JSON value
interface InjectResponse {
  status
  headers: Record<string, string | string[]> // repeats joined with ", "; set-cookie: an array
  body: string
  bytes: Uint8Array
  json<T>(): T
  cookies: Record<string, SetCookieInfo> // set-cookie parsed by name (the last one wins)
}
interface InjectStreamRequest extends InjectRequest {
  signal?: AbortSignal // aborting it disconnects the client
}
interface InjectStreamResponse {
  status
  headers
  cookies
  body: ReadableStream<Uint8Array> // cancelling it disconnects the client
}
```

Adapters only route and translate I/O; everything else is done by the plugin so every adapter
behaves the same. A reply is an event stream (`eventStream`) when its body is a stream with a
`text/event-stream` content type, whatever produced it (`@Sse`, `HttpResponse.sse()`, a proxied
`fetch()` response, `HttpResponse.stream()`): the adapter sends its headers without waiting for the
first chunk (a quiet stream may send nothing for a while). An adapter without `streamBody` gets
multipart uploads buffered before parsing. A
stream body MUST be read to its end or cancelled (client gone, HEAD...), since the request scope and
the in-flight count stay open until then. Files (and every `Blob` result) are such streams, reading
the `Blob` given in `reply.blob` with its `content-length`: an adapter MAY send that `Blob` natively
instead (`new Response(blob)` on `Bun.serve()`: `sendfile`, exact length) and then MUST cancel `body`
once the server holds the blob (its file opened), which releases the request scope (that may delete
the file). An adapter MUST NOT rethrow a failure to write a reply into its framework's error handler
(the request would be served twice): it releases the body and answers a plain 500. When its native
router misses a request (normalised path...), it calls the fallback handler, which routes the raw
path. **Impl.** adapter specifics: Fastify hides a `content-type` it cannot parse from its own
parsers on Znight routes (restored for the plugin), so they answer like the other adapters instead of
Fastify's 415; Express answers 500 with an explicit log entry when a body parser already consumed
the body; `honoAdapter({ app?, serveOptions? })` passes `serveOptions` to `Bun.serve()` with
`maxRequestBodySize` unlimited by default (the plugin enforces the body limits) and lifts Bun's
`idleTimeout` while a streamed response is sent; on `Bun.serve()` a file is handed to Bun, which
opens it at once, and the scope closes then. On `@hono/node-server`, a reply whose client already
left (an async step before the handler returned) has its body discarded, and a stream body nobody
locked is cancelled when the response closes unfinished: the server would neither read nor cancel
it, and the event source, the request scope and the in-flight count would stay open.

`inject` is in-memory (fastify `inject`, hono `request`, node and express via `light-my-request`, an
optional peer): strings and bytes are sent as is (`text/plain` / `application/octet-stream` without
`content-type`), a `FormData` as `multipart/form-data` (boundary from the Fetch API encoding), a
`Blob` / `File` with its type, other values as JSON; the response has the UTF-8 `body` and the raw
`bytes` (downloads); `headers` holds lower-case names, repeated headers joined with `, ` except
`set-cookie`, always an array (one entry per cookie: cookie values may contain `, `), parsed into
`cookies` (`parseSetCookie`). An event stream (`text/event-stream`) makes `inject` reject with a hint
instead of waiting for its end. `HttpPlugin.injectStream(request)` (method defaulting to `GET`)
resolves at the response headers; `HttpPlugin.injectSse(request)` builds on it and reads the stream
like `EventSource`. Opening never waits forever: without response headers within 2 000 ms the
request is aborted (the server sees a client disconnect) and `injectSse` rejects, naming the
request. Otherwise it resolves once the first chunk was read (the preamble of an `@Sse` stream, so
`retry` is known), or after 2 000 ms more for a stream that sends nothing yet (still read in the
background: a quiet stream never hangs the test). It exposes `status`, `headers`, `cookies`;
`body` / `json()` for a reply that is not an event stream; events read only when asked for
(`next({ timeoutMs })`, 2 000 ms by default, rejecting with `no event received`, plus `the stream
has sent nothing since it opened` for a quiet one; `take(n)`, async iteration); `comments`,
`lastEventId`, `retry`, `done`, `close()` (a client disconnect; also `await using`) and
`reconnect()` (the same request plus
`last-event-id`). The adapters that write to a Node.js response (node, express, fastify through
`reply.hijack()`, Hono on `@hono/node-server`) disable the socket timeout of an event stream
(`setTimeout(0)`), and `honoAdapter().listen()` lifts `Bun.serve()`'s `idleTimeout` while it is
sent. Subpaths:
`@znight/http/node` (built-in, also the root default), `/fastify`, `/express`, `/hono` (`Bun.serve`
on Bun, `@hono/node-server` on Node), `/path` (path grammar helpers). Request-scoped externals:
`HttpContext` (and the branded string `RequestId`) are provided per request; `HttpPlugin` itself is
injectable.

### 9.2 Messaging (`@znight/messaging`)

```ts
interface MessagingMetadata {
  consumers: ConsumerDefinition[]
}
interface ConsumerDefinition {
  token
  queue // queue (RabbitMQ, SQS) or topic (Kafka)
  options?: { concurrency?: number; deadLetter?: string | false; [driverOption: string]: unknown }
  handlers: MessageHandlerDefinition[] // declaration order
  errorHandler?: string // @OnError method: consumer[name](error, message)
}
interface MessageHandlerDefinition {
  method: string
  type?: string // exact or `*` pattern; absent = default handler
  retry?: { attempts: number; backoff: 'fixed' | 'exponential'; delay: number; maxDelay?: number } // normalised
  invoke: (consumer: any, message: InboundMessage) => unknown
}
```

`invoke` maps parameters: `@Message()` → `m.payload`, `@Message(S)` → `await validateMessage(S,
m.payload)` (the arrow becomes `async`), `@Headers()` → `m.headers`, `@Headers('x')` →
`messageHeader(m, 'x')`, `@Ctx()` → `m`.

Delivery state machine (at-least-once; handlers must be idempotent and may deduplicate on
`message.id`):

- each delivery waits for a concurrency slot (released at once when stopping), the handler is
  selected and the body decoded, then it runs in its own scope (`InboundMessage` request-scoped
  external) through `hooks.run('messaging:message')` → invoke → settlement;
- handler selected by `message.type` (exact match first, then patterns); a handler without type is
  the default; no match → terminal failure (reason `no-handler`);
- success → ack; `NonRetryableError` (recognised across package copies), schema failure
  (`MessageValidationError`, reason `validation`) or undecodable body (`decode`) → terminal
  immediately;
- retryable failure with attempts left → retry as `attempt + 1`: the delay (`delay` × 2^(attempt−1)
  for `exponential`, capped by `maxDelay`) is waited in-process when ≤ the driver's
  `maxInProcessDelayMs` (the message stays locked) and the message is then **redelivered through the
  broker** (never re-invoked locally); longer delays use the driver-native delayed redelivery. The
  attempt count comes from the broker (SQS `ApproximateReceiveCount`, RabbitMQ `x-delivery-count`)
  or the `x-znight-attempt` header. When the driver cannot schedule the retry, the message is
  released after `defaults.requeueDelay`. Boot fails (ZNIGHT011) if a `@Retry` cannot be honoured;
- terminal failure (last attempt, non-retryable, validation, decode, no handler) → `@OnError`:
  returning `'ack'` acks, otherwise (or on throw) dead-letter. `@OnError` is **not** called for a
  redelivery beyond `maxAttempts` (dead-lettered with `max-attempts` without running the handler)
  nor when a hook wrapper prevented the handler from running (counted as a failed attempt);
- dead-letter: publish with confirmation, then ack the original; when the publication fails, the
  message is released after `defaults.requeueDelay` (1 s) and redelivered. The destination is
  `@Consumer({ deadLetter })` > `defaults.deadLetter(queue)` > `driver.deadLetterName(queue)`;
  `false` disables dead-lettering (RabbitMQ rejects natively, SQS/Kafka discard). The copy keeps
  body, type, id and headers (minus `x-znight-attempt`) and adds `x-znight-dead-letter-reason`,
  `x-znight-error`, `x-znight-original-queue`, `x-znight-attempts`;
- nothing is dropped: every path ends with the broker owning the message (acked, republished,
  dead-lettered or released).

Defaults: `concurrency` 1; handlers without `@Retry` use `defaults.retry`, by default 3 attempts,
exponential from 1 s capped at 30 s (`attempts` counts the first delivery; `retry: false` = a single
attempt).

`MessagingPlugin.configure({ driver, defaults?: { retry?, concurrency?, deadLetter?, requeueDelay? },
codec?, consume? })` (`defaults.deadLetter`: `(queue) => string` or `false`; default codec JSON;
`consume: false` for publish-only processes):
`register` provides `MessageBroker` (value) and declares `InboundMessage` (request external);
`onBootstrap` validates the options (an invalid `driver`, `defaults`, `codec`... fails
`Application.create()` with ZNIGHT011, the code of invalid consumer settings), the consumers and
the retry policies against the driver capabilities, then connects; `onStart` subscribes (all or
nothing); `onStop` stops receiving, aborts in-process retry waits (messages released), aborts
`message.signal`, awaits in-flight handlers; `onDispose` closes the driver. While consumers are
subscribed (from the end of `onStart` to the end of `onStop`), the plugin keeps the process alive (a
referenced interval timer):
a worker whose only ingress is a consumer does not exit after `start()`, whatever the driver (the
memory driver holds no handle), and stops only through `stop()` or a signal. The instance exposes
`broker`, `driver`, `consumers()`.

The runtime logs each retry (`warn`) and dead letter (`error`) with the error (`err`, stack
included). When a `messaging:message` wrapper is installed (an observer logging each delivery with
its error), these entries keep their level but carry `error` (the message only), so that a stack is
logged once.

`MessageBroker` (abstract class, injectable) exposes `publish(queue, payload, { type?, headers?,
key?, delay?, id?, contentType? }): Promise<{ id }>`, resolved once the broker confirmed the
message, wrapped in `hooks.run('messaging:publish')` (wrappers may add headers before `next()`).
`InboundMessage` exposes `id`, `queue`, `type`, `payload`, `headers`, `key`, `attempt`,
`maxAttempts`, `redelivered`, `timestamp`, `receivedAt`, `contentType`, `body`, `driver`, `raw` and
an `AbortSignal` aborted on stop.

```ts
interface MessagingDriver {
  name: string // InboundMessage.driver
  capabilities: {
    nativeDelay: boolean
    maxNativeDelayMs: number
    maxInProcessDelayMs: number
    deliveryCount: 'native' | 'header'
    maxPublishDelayMs: number // 0: delayed publishing unsupported
  }
  connect(context: { logger: CoreLogger }): Promise<void>
  subscribe(
    queue,
    handler: (delivery: DriverDelivery) => Promise<void>,
    options: SubscribeOptions,
  ): Promise<Subscription>
  publish(queue, message: OutboundMessage): Promise<void> // resolves once confirmed
  close(): Promise<void>
  deadLetterName(queue: string): string
}
// DriverDelivery: id, body, contentType, headers, type, key, attempt, redelivered, timestamp, raw +
//   exactly one settlement: ack() | retry({ attempt, delayMs, error }) | deadLetter({ queue, reason,
//   error, attempt }) | release(), possibly followed by release() when it failed
// SubscribeOptions: consumer, concurrency, deadLetterQueue, maxAttempts, retryDelays, options (driver options)
// Subscription: cancel() (stop receiving), close() (after in-flight settlements)
```

Drivers verify their topology (and native DLQ configuration) at subscribe time. **Impl.** driver
specifics:

| Driver                         | Attempts                                                                                  | Native delay                                                                                     | In-process budget | Dead letters                        | Notes                                                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/memory`                      | native                                                                                    | timers (longer than 2^31 − 1 ms: chained)                                                        | 1 s               | `<q>.dlq`                           | deterministic test broker (`send`, `idle`, `settlements`, `deadLetters`, `published`, `fail`...)                                                                                                                                                       |
| `/rabbitmq` (amqplib)          | `x-znight-attempt` + redeliveries (quorum `x-delivery-count`, classic `redelivered` flag) | retries: delay queues `<q>.delay.<ms>` (TTL + DLX); delayed publications: 32 shared delay levels | 5 s               | `<q>.dlq`, publish confirmed + ack  | quorum queues by default (`queueType`), confirm channel + `mandatory`, `prefetch = concurrency`, publishes through the default exchange (and the delay levels), topology declared or verified, `x-delivery-limit: -1` (RabbitMQ ≥ 4), recovery (below) |
| `/sqs` (client-sqs ^3.600)     | `ApproximateReceiveCount`                                                                 | visibility timeout (≤ 12 h)                                                                      | 1 s               | `<q>-dlq` or `RedrivePolicy` target | queues never created; `maxReceiveCount` ≥ attempts checked; lease extension (stopped before each settlement); FIFO groups by `key`                                                                                                                     |
| `/kafka` (@platformatic/kafka) | `x-znight-attempt`                                                                        | retry topic `<group>.retry` (`x-znight-not-before`, ≤ 15 min: `maxRetryDelayMs`)                 | 0                 | `<topic>.dlq`                       | one consumer group per `@Consumer` (`<groupId>.<topic>`, override with `groupId`), manual commits (never moving back), partitions sequential, deduplication after a rebalance, back-pressure per stream, no delayed publish                            |

More on the drivers:

- **RabbitMQ delays.** Retries go through per-delay queues `<q>.delay.<ms>` (the delays come from
  the `@Retry` policies: a bounded set, declared at subscribe time). Delayed publications
  (`publish(..., { delay })`, up to 2^32 − 1 ms) never create a queue per delay: they go through 32
  **delay levels** shared by every queue of the virtual host, `<delayLevelPrefix>.0` to `.31`
  (default `znight.delays`), each a topic exchange and a queue with a TTL of 2^n ms. The delay,
  rounded up to an odd number of milliseconds (so that every path ends in level 0, never shortened;
  each level crossed adds a few ms), is written in binary in the routing key: the message waits in
  the level of each set bit, then level 0 dead-letters it to the default exchange, which delivers
  it to its queue (named in the `CC` header). The levels are declared on the first delayed
  publication of each connection, whatever `assertTopology`; quorum levels use at-least-once
  dead-lettering. The declaration cache is invalidated when a publication to a level or a delay
  queue fails.
- **RabbitMQ delivery limit.** On RabbitMQ ≥ 4, declared quorum queues (consumed and dead-letter
  queues) get `x-delivery-limit: -1` unless `queueArguments` sets it: Znight counts the attempts,
  whereas the broker's default limit (20 deliveries, releases included) would drop a message
  released repeatedly. A queue that already exists without the argument fails the declaration
  (`PRECONDITION_FAILED`): it is declared again as it is and a warning recommends a
  `delivery-limit: -1` policy. Classic queues and RabbitMQ 3.x are unchanged.
- **RabbitMQ recovery.** Reconnection and resubscription go through a single recovery loop (with
  backoff) that ends only when the connection is the one it opened and every active subscription
  consumes again: a connection lost during the recovery, a consumer channel closed by a channel
  error and a consumer cancelled by the broker (`basic.cancel`: queue deleted, node down; the
  queues are declared again with `assertTopology`) are all resumed. Messages in flight on a lost
  channel are redelivered by RabbitMQ.
- **RabbitMQ publications.** A returned (unroutable) message fails only its own `publish()`: it is
  matched with the oldest pending publication with the same exchange, routing key and message id.
  Retried and dead-lettered copies carry the type that selected the handler (a type read from the
  routing key, `typeFromRoutingKey`, included) and never the `CC` / `BCC` headers nor the broker's
  `x-death` headers.
- **Kafka.** Each partition remembers the next offset it expects: after a rebalance, records a kept
  partition fetches again from the committed offset are skipped (commits never move back), and the
  buffered (or late) records of a revoked partition are dropped, its new owner handles them. The
  main and retry streams have their own buffer and thresholds (a backlog of retries waiting for
  their `x-znight-not-before` never pauses the main topic); a stream is paused again even if it was
  paused, since the client resumes its streams after a rebalance. The not-before timer is capped at
  2^31 − 1 ms.
- **SQS.** The lease extension of a message stops, once any extension in flight completed, before
  its settlement is sent, so that it never overrides the visibility set by a retry or a release.

### 9.3 Config (`@znight/config`)

```ts
interface ConfigMetadata {
  configs: { token; prefix?; fields: ConfigFieldDefinition[] }[] // sorted by token
}
interface ConfigFieldDefinition {
  property: string
  env: string // @Env(name) | @Secret(name) | CONSTANT_CASE(prefix_property)
  key: string // @Key(path) | '<prefix>.<property>'
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'url' | 'json'
  enum?: (string | number | boolean)[] // literal unions and TS enums
  default?: unknown // @Default only
  required: boolean // false with `?`, `| undefined`, @Default or any initializer
  secret: boolean
}
```

Config classes are singleton providers with dependency `{ token: '@znight/config#ConfigSource',
optional: true }` and factory `d => loadConfig(Class, d[0], Class$fields)` (`loadConfig(Class,
source | undefined, fields, { name?, env? })`). Type mapping: `string`/`number`/`boolean` (and
their literal unions, branded primitives), `string[]`/`number[]`, `URL` (`globalThis` or `node:url`)
→ `url`, objects, records, tuples, `unknown`/`any` → `json`; without annotation the type is inferred
from the initializer or `@Default`; anything else (incl. `boolean[]`, `URL[]`) is ZNIGHT012.
Properties of analysable base classes are included with the derived class prefix.

Resolution (normative), per field: (1) the env name in the source, whichever loader provided it;
(2) the key path, nested (`{ database: { password } }`) or flat (`{ "database.password": ... }`);
(3) `@Default`; (4) the initializer. Within the source, later loaders override earlier ones. An
invalid value is an error and never falls back to a lower level. Blank values count as unset for
every type except `string`. Coercion: strict decimal numbers; booleans `true/false/1/0/yes/no/on/off`;
arrays from comma-separated strings; `url` always produces a `URL` instance (absolute, a
scheme-less `localhost:5432` is rejected); `json` parses strings and deep-copies structured values;
enums are checked after coercion (every element for arrays).

`ConfigPlugin.configure({ loaders = [dotenv(), env()], cwd, env, validate = true })` (name `config`,
`.source`): `register()` runs the loaders in order (each sees the previous layers through
`ctx.source`), registers the `ConfigSource` external (`ConfigTokens.Source`) and validates every
config class at once, throwing `ConfigValidationError` (ZNIGHT006, every problem with the origin of
each value). **Impl.** validation runs before `overrides` are applied: a test overriding a config
class passes `validate: false` or supplies values with `inline()`. Without the plugin, each config
class reads a snapshot of `process.env` when created (failure: ZNIGHT015 caused by ZNIGHT006).

```ts
interface ConfigSource {
  get(key: string): unknown
  has(key: string): boolean
  keys(): readonly string[]
  origin(key: string): string | undefined // 'process.env', '.env.local', 'vault:secret/app'...
  describe?(): string
}
interface ConfigLoader {
  name: string
  load(ctx: { cwd; env; source: ConfigSource }): ConfigLayer | ConfigLayer[] | undefined | Promise<...>
}
```

Loaders: `env({ prefix?, keepPrefix?, env? })`; `dotenv({ path?, nodeEnv?, optional?, populate?,
override? })` (default files `.env`, `.env.local` (skipped in `test`), `.env.<mode>`,
`.env.<mode>.local`, parsed with `node:util` `parseEnv`, no `${VAR}` expansion, `process.env`
untouched unless `populate`); `json(path, { optional?, key? })`, `yaml(...)` (optional peer `yaml`);
`vault({ path, address?, token?, tokenFile?, mount?, kvVersion?: 1 | 2, namespace?, key?, optional?,
timeoutMs?, retries?, retryDelayMs?, fetch? })` (KV, token auth); `awsSecretsManager({ secretId,
region?, client?, clientConfig?, optional?, timeoutMs? })` (optional peer
`@aws-sdk/client-secrets-manager`); `inline(values, { name? })`. A failing loader throws
`ConfigLoaderError` (ZNIGHT006); invalid options or metadata are ZNIGHT012. Loader errors never
quote values: a JSON or YAML syntax error gives the file, the line, the column and a fixed reason
(the YAML error code), never the parser message, which quotes the input (a secret, maybe), and the
parser error is not kept as `cause`; YAML warnings are re-emitted the same way (`YAMLWarning`).

**Impl.** Bun loads `.env`, `.env.<mode>`, `.env.local` (not in `test`) and `.env.<mode>.local` into
`process.env` before the application runs, with its own rules (mode `production` or `test` when
`NODE_ENV` is exactly that, `development` otherwise; `.env.local` over `.env.<mode>`; `${VAR}`
expanded). `env()` cannot tell those values from the real environment: they win over `dotenv()`
and are reported as `process.env`. On Bun, `env()` (reading the default `process.env`) emits a
`ZnightWarning` once per process naming the files Bun loaded, unless Bun's loading is disabled
(`env = false` in `bunfig.toml`, `bun --no-env-file`, `--env-file`); `env({ env: process.env })`
skips the check.

Secrets: `@Secret` values are masked (`[REDACTED]`) by non-enumerable `toJSON`, `toString` and
`util.inspect.custom` installed on the instance (methods the class defines are kept) and in error
messages; the property itself keeps the real value. A `ConfigSource` never prints its values.

### 9.4 Observability (`@znight/observability`)

`ObservabilityPlugin.configure({ logging?, metrics?, tracing? })` (name `observability`) provides
`Logger`, `MetricsRegistry`, `Tracer`, `LoggedInterceptor`, `TracedInterceptor`,
`MetricInterceptor`, replaces the core logger (`app.setLogger`, `component: 'znight'`, unless
`logging.replaceCoreLogger: false`) and wraps `http:request` / `messaging:message` (request logs, RED
metrics, spans with W3C trace-context), `messaging:publish` (producer span, trace context
injected into the message headers) and `schedule:run` (one span `schedule <job>` per executed run,
the root of a new trace except for manual triggers; the `schedule_*` metrics: runs, duration,
lateness, active runs, last success, with the `job` label capped at `maxJobs` then `_OTHER`; one log
entry per run, written inside its span), and listens to `schedule:run` for the occurrences that did
not execute (counters, `job skipped` / `job not acquired` entries). A run vetoed by a
`schedule:run` wrapper (§8.3) is `skipped` wherever that wrapper sits relative to the plugin's own:
a `job skipped` entry at `warn` without `durationMs` nor `err`, counted `skipped` but neither timed
nor recorded as a success (`last success` keeps aging, so a staleness alert keeps firing), and, when
its span is already open, a span with outcome `skipped` and status `UNSET`; a wrapper that throws
before the job is `failed`. Inside a run, the logger adds
`job` and `runId` (from the request-scoped `@znight/schedule#JobContext`; `logging.jobContext`).
Each part can be turned off: `metrics: false`, `tracing: false`, `logging.requests` /
`logging.messages` / `logging.jobs: false`, and per hook (`tracing.http`, `metrics.messaging`,
`metrics.schedule`, `tracing.schedule`...). `@znight/schedule` is not a dependency: the hook events
are typed by core (§8.3).
`onStart`/`onStop` start and stop the `/metrics` server (`node:http`, default port 9464, only when
metrics are enabled; `metrics.server: false` disables it); `onDispose` removes the wrappers, closes
the server, flushes the tracer provider and the logger, then switches the logger to flushing every
entry as soon as it is written (once per tick, the pending request keeping the process alive), so
the final `Application stopped` / `The application stopped with errors` entries are delivered too
(`Logger.close()` does the same; the logger stays usable).

- **Externals registration** (normative for this plugin): the six externals are registered with
  `container.register()` as **transient definitions returning the plugin's single instance** (not
  `registerValue`): they are created on injection only, never lifecycle-managed nor disposed by the
  container, and a disabled feature (e.g. `MetricsRegistry` without `prom-client`) fails only where
  it is injected (ZNIGHT015). The manifest still declares them `singleton`.
- **Function options timing**: object options are validated (and the core logger replaced) in
  `register()`. Function options (`configure(c => ...)`) are evaluated when the first observability
  external is injected during `container.init()`, or in `onBootstrap` if nothing injects one — so
  the function may only use synchronous providers that do not depend on observability (typically
  config classes).
- `Logger` is pino-based (`trace` ... `fatal`, `log`, `child`, `isLevelEnabled`, `level`, `flush`),
  accepts `(message, context | Error)` and `(context, message)`, and adds `requestId` (from the
  current scope, token `@znight/http#RequestId`) and `traceId`/`spanId` (active span). Level:
  option, else `LOG_LEVEL`, else `info`. Transports: console (default), pretty (optional peer
  `pino-pretty`), CloudWatch (stdout JSON), Datadog (HTTP intake, batching, retries; entry fields
  clashing with the reserved attributes are kept, never overwritten: an HTTP status code in `status`
  becomes `http.status_code`, another `status`, a `message` next to the log message and a
  `timestamp` next to the log time go under `attributes.*`).
- Metrics (`prom-client`, optional peer) are enabled by default only when it is installed;
  `metrics: false` runs `@Metric` methods unmeasured. HTTP labels use the route pattern (`unmatched`
  when none), never the raw path. The messaging `type` label is `unmatched` when no handler matched
  (never a raw type chosen by producers), otherwise the type, capped at `maxTypesPerHandler` (50)
  distinct values per (queue, consumer, handler), then `_OTHER`. The default process metrics are
  collected once per process and configuration (prom-client never releases their collectors) and
  shared by every `MetricsRegistry`, each with its own default labels, so registries of disposed
  applications are garbage collected. `MetricsRegistry` returns the existing metric for the same
  name and throws ZNIGHT005 when type or labels differ.
- Tracing uses `@opentelemetry/api` (spans are recorded by whatever SDK the application registers);
  without a global propagator a built-in W3C `traceparent` propagator is used, and when no context
  manager is registered by the time a context is first activated (request, delivery, publish,
  `withSpan()`, `@Traced`), a minimal `AsyncLocalStorage` one is registered, so incoming trace ids
  reach the logs and the published messages without SDK (an SDK registered later is refused by the
  OpenTelemetry API: register it before the first request). 5xx sets the span status to `ERROR`.
- Interceptors follow `invocation.isAsync`. Interceptor options in the metadata are validated in
  `register()` (a bad option fails `Application.create`). Instrumentation never changes the outcome
  of a request or method: a recording failure is reported once as a process warning and swallowed.

### 9.5 OpenAPI (`@znight/openapi`)

The compiler extension (`@znight/openapi/compiler`, RFC 0002) reads the data stored by
`@znight/http/compiler` (`graph.extensions`: routes, parameters with their coercion plans and
`defaultValue`, uploads, `sse`, effective metadata and groups), the JSDoc (`doc`), the decorator
type arguments (`typeArgs`) and the type shapes of the compiler (`ctx.types.shape()`, §6.5), and
generates `metadata.extensions.openapi` (format 1). Everything is JSON except the `schema` values of
the slots (Standard Schemas imported by the generated module):

```ts
interface OpenApiMetadata {
  version: 1
  fingerprint: string // SHA-256 (base64url) of the section, schema values replaced by their names
  document: OpenApiDocumentTemplate // openapi '3.1.1', info, servers?, tags?, externalDocs?, security?, x-*
  operations: { controller: Token; handler; route; method; path; operation: OperationTemplate }[] // by path, then method
  components: Record<string, SchemaTemplate> // JSON Schemas of TypeScript declarations, sorted
  securitySchemes: Record<string, SecuritySchemeObject>
  schemas: { name; schema: StandardSchemaV1; io: ('input' | 'output')[]; source? }[] // converted at assembly
  errors?: { contentType: string; schema?: string } // absent with errors: false
  tagDescriptions?: Record<string, string> // JSDoc of the controllers, by default tag
}
```

- Where a schema is expected the compiler writes JSON Schema 2020-12 or a placeholder
  `{ $znight: 'schema', name, io }`; in `parameters`, `{ $znight: 'parameters', in, name, io: 'input' }`
  stands for one parameter per property of an object schema. The `$znight` key is reserved
  (ZNIGHT030).
- Inference (normative summary): one operation per route and method (`@All`: GET, POST, PUT, PATCH,
  DELETE; automatic HEAD / OPTIONS are not documented); `:id` → `{id}`, `*` → `{wildcard}`
  (`{wildcard_1}` when the path has a `:wildcard` parameter, `{wildcard_2}` when it also has
  `:wildcard_1`, and so on); paths never contain the HTTP prefix. Routes of one path whose
  templates differ only by their parameter names (`/books/:id`, `/books/:bookId`) are documented
  under one template, OpenAPI forbidding two templates of one path: the first in code-point order,
  or the template of a whole-path `@Param(S)` schema (such operations keep theirs), the path
  parameters renamed by position, with a ZNIGHT035 warning. Parameters from `@Param` / `@Query` /
  `@Headers` / `@Cookie` / `@SignedCookie` (`in: cookie`) with the schema of their coercion plan and default value, or the
  **input** schema of their Standard Schema. Request bodies from `@Body(S)` / `@Validate(S)` (input
  schema) or the declared type, uploads as `multipart/form-data`.
- Success response (normative summary): the status is `@HttpCode`, else 201 for POST, else 200
  (204 when nothing but `void` / `undefined` / `never` is returned). The annotated return type
  (`Promise` unwrapped) is read member by member: `HttpResponse<T>` members are documented as `T`
  (`HttpResponse<A> | HttpResponse<B> | C` as `A | B | C`, repetitions removed) and make the status
  dynamic, so `@ApiResponse` may declare other 2XX statuses; an `undefined` member adds an empty 204
  response (not on POST nor with `@HttpCode`; `@ApiResponse(204)` is then accepted). The media
  types are the serialiser's: strings, string literals and string enums are `text/plain`, the other
  members `application/json` (a mixed union such as `string | null` gets both media types, each with
  its members); schema output aliases such as `z.output<typeof S>` give the **output** schema;
  a single bytes, `Blob` or stream type (or `HttpResponse<FileBody>`) is
  `application/octet-stream`; `@Sse` routes and a single `AsyncIterable` are `text/event-stream`
  with `x-znight-event-schema`; `HttpResponse<SseBody>` (`HttpResponse.sse()`) is a 200 (even on
  POST, unless `@HttpCode`) `text/event-stream` response (an event stream or another body:
  ZNIGHT031). A body on a bodyless status (`@HttpCode(204)`, `304`, 1xx) is a ZNIGHT035 error and
  the content is dropped; `HEAD` operations never have content. No annotation, `unknown`, a bare
  `HttpResponse`, a Web `Response` or `@Res()` is ZNIGHT031 unless `@ApiResponse` documents it.
  Standard errors: 400 on routes that coerce or validate, 413 on routes reading a body, 415 on
  upload routes, `HttpErrorBody` for declared 4XX / 5XX responses without schema.
- Components (compile time): a named declaration is named after it, a generic instantiation after
  the names of its arguments (`Page<Book>` → `Page_Book`); an argument that does not name itself
  (an object literal, a tuple, an opaque type, a generic reference) adds the first 8 hexadecimal
  characters of the SHA-256 of the instantiation key (`Page<{ id: string }>` →
  `Page_object_1a2b3c4d`), and so does an instantiation whose name another instantiation of the
  same declaration already has (`Box<Book[]>`, `Box<BookArray>`). Once every operation is built,
  a declaration named like a Standard Schema slot is ZNIGHT034 whatever the route order, except a
  declaration merged with the schema it is inferred from (`const User = z.object(…)` and
  `interface User extends z.infer<typeof User> {}`: one identity), documented by the schema (its
  output variant). A union of objects with a required string literal property of distinct values is a
  `oneOf`, with a `discriminator` (and its `mapping`) only when every member is a named component
  (tools would read the values as component names otherwise). A `bigint` first met in a request
  (warning) is reported again as an error when a response returns it.
- Security, first rule that applies: `@ApiSecurity` of the route, of the controller, the first
  `decisions` entry whose route decorator is in the effective metadata (`scopes: 'value'` turns a
  static string array value into scopes), else the document `security`.
- Diagnostics ZNIGHT030–036 (§4.8). The extension never runs application code.

`buildOpenApiDocument(metadata, options?)` (normative, pure, async) assembles the document: (1)
converts each schema slot with the first converter that answers (the `converters` option, then
Standard JSON Schema, then the `@valibot/to-json-schema` fallback, its options passed as
`libraryOptions`), input and output separately; dates are `date-time` strings in responses (Zod
`z.date()`, Valibot `v.date()`: `Date.prototype.toJSON`) and for coerced Zod dates in requests
(`z.coerce.date()`); failures are collected into one ZNIGHT037 (or `{}` and a warning with
`unrepresentable: 'warn'`); (2) names the converted schemas: each one is split into its root and
its `$defs` / `definitions` (at any depth), hoisted into `components.schemas` with every local
reference rewritten (`#` is the document in OpenAPI). A definition with a library id
(`.meta({ id: 'Address' })`) is named after it; anonymous definitions (Zod's `__schemaN` of a
recursive schema) are scoped to their slot (`Tree_schema0`); a root that only references one
definition (`{ $ref: '#/$defs/X' }`) is unwrapped when X is anonymous or named after the slot (a
root `.meta({ id })` equal to the export name), and stays an alias of X otherwise. Every name, slot
or definition, gets an `XInput` variant when its input and output JSON Schemas differ, directly or
through a definition it references (propagated to a fixed point); two different schemas of one io
under one name (or a clash with a TypeScript component) are ZNIGHT034; (3) adds the standard error
components; (4) replaces the placeholders: a property of a whole-object parameter schema that an
explicit parameter or another expansion of the operation already documents (same location and
name, header names case-insensitive) is dropped, with one ZNIGHT035 warning; (5) builds the
operations and applies `filter`, pruning unreferenced components; (6) builds the root (`info`
merged with the option, `servers`: the option, else the declared servers, else
`[{ url: prefix }]`, plus `x-znight-fingerprint`) and applies `transform`; (7) deep-freezes it and
serialises `json` (`JSON.stringify(document, null, 2)` plus a newline). It returns `{ document,
json, warnings, stats }`. The same function runs at boot, in `znight openapi` and in tests, so the
served document and the emitted file are byte-identical.

`OpenApiPlugin.configure(options | (container) => options)` (name `openapi`):

- `register` provides the `OpenApi` external (singleton: `document()`, `json()`, `yaml()`,
  `operations`); `initRoots()` returns the classes of the `guards` option.
- It serves its routes as **plugin routes** of `HttpPlugin` (`httpRoutes`, §9.1; no `http` plugin:
  ZNIGHT030): `path` (`/openapi.json`), `yaml` (optional peer `yaml`), the UI page at `uiPath`
  (`/docs`, Scalar or Swagger UI, local assets under `${uiPath}/_assets/` or a pinned CDN with
  Subresource Integrity, `assets: 'auto' | 'local' | 'cdn'`) with its own
  `content-security-policy` (inline script allowed by hash, `connect-src` limited to the origins of
  the served document's servers in every build mode: with `'first-request'` the first request of
  the page builds the document; when the build fails, the page allows the declared servers, static
  or from the `servers` option, and is not cached). The installed UI package is found from
  `@znight/openapi`, then from the working directory, through `<package>/package.json` when it
  resolves, else in the `node_modules` directories of the resolution paths (the manifest `name`
  checked), so a package whose exports map hides its manifest (`@scalar/api-reference`) is found on
  Node.js as on Bun. The routes take `meta` (route decisions, checked by the ZNIGHT023 boot check)
  and `guards`, and are listed with `source: 'openapi'`.
- The document is built in `onBootstrap` (`build: 'boot'`, a failure fails the boot) or on the first
  request (`'first-request'`: one shared promise, retried after a failure); with
  `document: { file }` it serves a prebuilt file instead (its `x-znight-fingerprint` differing from
  the metadata's is a ZNIGHT030 warning). The runtime options apply to a file as to a build:
  `filter` (operations matched by path and method, an operation unknown to the metadata kept; empty
  paths, unused tags and unreferenced components pruned), `info`, `servers`, else `[{ url: prefix }]`
  when the file declares no servers, then `transform`; the file is served byte for byte when none
  of them applies. Under an HTTP prefix, a file without `servers` is a ZNIGHT030 warning (emit it
  with `znight openapi --prefix` or `znight build --openapi-prefix`), and relative servers of the
  file that do not end with the prefix are one too. Bodies are precomputed bytes with a strong ETag
  (`if-none-match` → 304, `HEAD` included) and `cache-control` (`no-cache`). `enabled: false` serves
  and builds nothing.
- Emission (`@znight/openapi/emit`, used by `znight openapi`, `znight build --openapi` and the
  `openapi()` Vite plugin of `@znight/openapi/vite`): compiles the application like `znight
  generate`, loads the generated module in a child process (Bun: the compiler preload; Node.js: a
  Vite server in middleware mode) without instantiating anything (`NODE_ENV` defaults to
  `production`), runs `buildOpenApiDocument` (with the HTTP `prefix` of the options: `znight openapi
  --prefix`, `znight build --openapi-prefix`, `openapi({ prefix })`, so that the file has the
  `servers` of the served document) and writes the outputs atomically, only when they changed.
  `check: true` never writes and reports stale or missing outputs; `check: [...]` checks only the
  listed outputs (relative to the root, each one an output, ZNIGHT030 otherwise) and writes the
  others. With `check`, the Vite plugin checks the outputs outside `build.outDir` (the committed
  files) and always writes those inside it (build artifacts, emptied by every build), with a
  warning when that leaves nothing to check. `@znight/openapi/testing` exports
  `validateResponse(document, { method, path, response })` (optional peer `@cfworker/json-schema`).

### 9.6 Schedule (`@znight/schedule`)

The compiler extension (`@znight/schedule/compiler`, RFC 0004) owns `#Cron`, `#Interval` and
`#Timeout`, validates every literal with the runtime's own cron engine and duration parser
(import-free modules, §2), declares each host with `AnalyzeContext.addRoot()` (a singleton when
nothing else registers it; recorded in compiled libraries, §6.4) and generates
`metadata.extensions.schedule`:

```ts
interface ScheduleMetadata {
  jobs: ({
    name: string
    token: Token // the host
    method: string
    overlap?: 'queue' | 'allow' // absent: 'skip'; never on timeouts
    lock?: boolean // absent: the plugin rule
    maxDuration?: number // ms
    enabled?: false
    invoke: (host, ctx: JobContext) => unknown // (c: Host, j: JobContext) => c.method(j)
  } & (
    | { kind: 'cron'; cron: string; timeZone?: string; runOnStart?: true } // as written, whitespace collapsed
    | { kind: 'interval'; every: number; runOnStart?: true } // ms
    | { kind: 'timeout'; delay: number } // ms after the scheduler started
  ))[] // sorted by name; options equal to their default are omitted
}
```

`SchedulePlugin.configure(options | (container) => options)` (name `schedule`; options `enabled`,
`timeZone` (`'UTC'`), `lock` (a `ScheduleLockStore` or `{ store, keyPrefix?, ttl?, owner? }`), `jobs`
(overrides by name: `enabled`, `cron`, `timeZone`, `every`, `delay`, `overlap`, `lock`,
`maxDuration`), `drainTimeoutMs` (4 000), `clock`):

- `register` provides `SchedulerRegistry` (singleton) and `JobContext` (request-scoped);
  `initRoots(context)` returns the hosts of `context.metadata.extensions.schedule`.
- `onBootstrap` validates the options and the section (it may be hand-written: shapes, names,
  expressions, zones with the runtime's `Intl`, host tokens: ZNIGHT001 naming the job), applies the
  overrides (ZNIGHT040 for another kind, ZNIGHT042 with a suggestion for an unknown name), checks
  the locks (ZNIGHT043), resolves the singleton hosts and binds the registry, usable from then on
  (before: ZNIGHT021). An instance serves one running application at a time (ZNIGHT004).
- `onReady` arms the scheduler when `enabled` (jobs never run against a half-started application),
  runs the `runOnStart` jobs and logs the next occurrence; its timer keeps the process alive.
- **Occurrences** (normative): one timer for every job, capped at 60 s and resynchronised with the
  wall clock, a heap ordered by time then name, indexed by job (at most one entry per job: `remove`,
  `pause` and `reschedule` take it out at once, so nothing retains a removed job until its old
  deadline). A cron job fires at the first matching wall-clock
  second after the previous occurrence, in its zone (an IANA name, `UTC`, `local` read once at boot,
  or a fixed offset, kept as written): a local time skipped by a DST gap fires once at the first
  instant after the gap (also when the search starts in the last second before it), and `matches()`
  agrees with `next()`: the end of a gap is an occurrence of the wall times it skips; a repeated
  local time fires at its first occurrence only, unless the hour field matches every hour. Day of
  month and day of week are OR-ed when both are restricted. In the day of week, `a/s` runs up to
  Saturday and `7/s` is Sunday alone; `SUN` closing a range is 7 (`FRI-SUN`) except after Sunday
  (`SUN-SUN`, `0-SUN`: Sunday, like `0-0`). Occurrences before 1970 are computed like any other
  (`next()`, `nextRuns()`, `matches()`). Zones are shared by the identifier `Intl` resolves a name to
  and only the last 256 spellings are remembered, so zone names from user input keep memory
  bounded. Intervals fire at the multiples of `every` since the Unix epoch; a timeout fires once,
  `delay` after the scheduler started. A late wake-up runs a job once, for its latest missed
  occurrence; an occurrence never runs twice in a process.
- **A run**: the overlap policy first (`skip`: outcome `skipped`; `queue`: one pending run, the
  latest occurrence; `allow`: concurrent, implies no lock), then the lock, then a new container scope
  seeded with its `JobContext` (`job`, `runId`, `trigger`, `scheduledAt`, `startedAt`, `previous`,
  `signal`), where request-scoped and transient hosts are created and disposed, and
  `hooks.run('schedule:run', event, invoke)` (§8.3); every occurrence is then emitted.
  `maxDuration` aborts `ctx.signal` with a `JobAbortedError` (ZNIGHT044, `reason: 'timeout'`)
  without freeing the slot. `HttpContext`, `RequestId` and `InboundMessage` do not exist in a run.
  A run **starts** when its job is called. Once its lease is acquired, and again when the hook
  wrappers call `next()` (both may wait), a run is dropped when its signal was aborted, the
  scheduler is stopping or disposed, the job was removed, or it was paused (manual runs excepted):
  outcome `skipped` (with `aborted` when its signal was aborted), logged at `debug`, its lease
  released (its job never started), and no timer is armed after the dispose. `pause()` also drops
  the queued occurrence of an `overlap: 'queue'` job; a queued `trigger()` still runs.
- **Locks** (normative): with a store, jobs are locked unless `lock: false` or `overlap: 'allow'`.
  `acquire(key, { owner, occurrence, ttlMs })` MUST grant a lease only when no lease is live **and**
  no later-or-equal occurrence of the key was claimed (occurrence fencing: clock skew between
  instances never runs an occurrence twice); a refusal is the outcome `not-acquired`. The lease is
  extended every `ttl / 3`, one extension at a time; it is lost when `extend()` answers `false`, or
  `ttl` after the call of the last successful extension, even while an extension hangs (a
  partitioned client queuing commands): the run is then aborted (`lock-lost`). A store failure
  fails closed (outcome `failed`, no run), and so does an `acquire()` that does not answer within
  `ttl` (a lease granted later is released at once); a `release()` that does not answer within `ttl`
  is logged at `warn` and frees the job (the lease expires). `release()` keeps the occurrence
  claimed. `memoryLockStore()` serves one process; `lockStoreScenarios`
  (`@znight/schedule/testing`) is the conformance suite of a store, and the package tests a Postgres
  and a Redis recipe against it (`test/integration`, `ZNIGHT_INTEGRATION=1`).
- **Shutdown**: `onStop` disarms the timer, drops queued runs, aborts every running run's signal at
  once (`shutdown`) and waits up to `drainTimeoutMs`; runs still in flight are abandoned (logged):
  their leases are neither released nor extended (a run whose job had not started yet, still
  waiting for its lease, is dropped and releases it). A `stop()` called from inside a run does not wait
  for it. `onDispose` clears the timers and unbinds the registry. List `SchedulePlugin` before
  `HttpPlugin`: plugins stop in reverse order, so HTTP drains first.
- `SchedulerRegistry`: `jobs()`, `get(name)`, `has(name)`, `addCron` / `addInterval` /
  `addTimeout(name, schedule, handler, options?)` (validated at once: ZNIGHT040, ZNIGHT041,
  ZNIGHT043), `remove(name, { abort? })` (runs not started yet are dropped, a running run goes on
  unless `abort`), `trigger(name)` (the whole pipeline, its own scope, even
  with `enabled: false`; resolves with the `JobRunResult`, never rejects for a job failure), `idle()`;
  each `ScheduledJob` has `pause()`, `resume()`, `reschedule()` (same kind; a timeout is armed
  again at `max(now + delay, last occurrence + 1 ms)`, also from its own run, and a `done` job is
  scheduled again), `trigger()`, `nextRun`, `lastRun`, `nextRuns(count)`. Reschedules and dynamic
  jobs are not persisted.
- `parseCron(expression, { timeZone? })` (`next`, `nextRuns`, `matches`) and `parseDuration` expose
  the engine (ZNIGHT040 as `InvalidScheduleError` with `field`, `start`, `end`).
  `@znight/schedule/testing` exports `createTestClock(start?, { settleTimeoutMs? })` (virtual time:
  `advance`, `advanceTo`, waiting for the runs it starts, real I/O included; a run that makes no
  progress for `settleTimeoutMs` of real time, default 1 000, is not waited for again during that
  call), `createJobContext()` and `lockStoreScenarios`.

## 10. Testing (`@znight/testing`)

```ts
const { instance, mocks, container } = await TestBed.create(UserService, { metadata })
mocks.get(UserRepository).findById.mockResolvedValue(null)

await using app = await TestApp.create({
  metadata,
  plugins: [HttpPlugin.configure({ adapter: fastifyAdapter(), port: 0 })],
  overrides: [[UserRepository, fakeRepo]],
})
const res = await app.inject({ url: '/users/1' }) // method defaults to GET
res.status
res.json()
```

- Metadata freshness: the `@znight/compiler/bun` preload (`bun test`) and the Vite plugin (Vitest)
  regenerate the module before the tests import it (§6.3); other runners run `znight generate`
  first.
  `@znight/testing` itself never compiles: it reads the metadata structurally (providers, aliases,
  externals, `extensions.config` / `http` / `messaging` / `schedule`) and does not depend on the
  feature packages.
- `TestBed.create(target, { metadata, provide?, overrides?, config?, mockFn?, deep?, aop? })` →
  `{ instance, mocks, container }`. The target (class, token, `TypedToken`, alias or unique display
  name) is built with its real generated factory (async factories awaited; factory errors →
  ZNIGHT015) and its **direct** dependencies are resolved by kind:

  | Dependency                                                        | Injected                                                                                                                                                                                       |
  | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | class / interface / `@Provides` value / external                  | deep auto-mock                                                                                                                                                                                 |
  | config class (`extensions.config`, read structurally)             | real instance: `new C()`, then `@Default` values (converted to the field type and winning over initializers, as in `loadConfig`), then `config` values (unknown class or property → ZNIGHT012) |
  | qualified value without class (`@Provides({ name })`, primitives) | the `provide` value, else ZNIGHT001                                                                                                                                                            |
  | optional / multi / `Lazy<T>`                                      | `undefined` / `[]` (plus provided members) / `{ get: () => mock }` (same mock as `mocks.get(T)`)                                                                                               |
  | interceptor dependencies                                          | not created, interceptors not applied — unless `aop: 'real'`                                                                                                                                   |

  `overrides` take values or provider definitions (built, their own deps resolved by the same
  rules) and win over `provide`. `mocks.get(key)` accepts classes, tokens, aliases and display names
  (typed `Mocked<T>` for classes and `TypedToken`s) and explains why a key was not auto-mocked; also
  `has`, `tokens`, `clearAll`, `resetAll`. TestBed never calls lifecycle hooks.
- Auto-mocks are non-thenable (`then`, `toJSON`, `asymmetricMatch`, `$$typeof`, `nodeType`,
  `tagName`, `__esModule`, `_isMockFunction`, `@@*` keys and symbols read as `undefined`);
  unconfigured methods return `undefined` (deep mocks with `deep: true`); with a class, `instanceof`
  works. Helpers: `createMock(Class?, partial?, { name, deep, mockFn })`, `isMock`, `clearMock`,
  `resetMock` (restores the initial implementation).
- The spy implementation is pluggable (`mockFn`, `setDefaultMockFn`) and auto-detected: Vitest
  (`globalThis.vi.fn`), Jest (`globalThis.jest.fn`), `bun:test` `mock` (on Bun), else the built-in
  Jest-compatible spy (`createSpy`).
- `TestApp.create({ metadata, plugins?, providers?, overrides?, only?, start?, logger?, shutdown? })`
  runs `Application.create` with signal handlers disabled, applies `overrides` last and, by default,
  instantiates only the closure of the HTTP controllers (with their guards and interceptors), the
  message consumers, the hosts of scheduled jobs (`extensions.schedule.jobs[].token`, disabled jobs
  included: they can be triggered), the override keys and the **plugin roots** (everything when
  there is no controller, consumer nor job; `only: 'all' | keys`, keys to which the override keys
  and plugin roots are added; `'all'` ignores plugin roots). Plugin roots are the providers a plugin
  resolves in `onBootstrap` although the metadata does not reference them (`HttpPlugin`'s global
  `guards`, `interceptors`, `exceptionMappers`): the optional `Plugin.initRoots(context: { metadata })`
  of core (§8.2; `PluginInitRoots` in testing), called once per `TestApp.create()` before
  `Application.create` (it SHOULD NOT throw: invalid options are reported by `onBootstrap`; a
  non-array result is a `TypeError` naming the plugin); keys that designate providers of the
  metadata are added, others are left to the plugin to report. Plugin roots only complete the entry
  points: they never restrict the boot. Options computed
  from the container cannot be listed (`HttpPlugin` returns `[]` then): when such a provider has an
  async dependency, the boot fails with ZNIGHT015 ("on demand: its factory is async") and TestApp
  adds the hint to list it in `only` (or pass `only: 'all'`).
  It starts the app unless `start: false` (so pass `port: 0`). Members: `inject(request)` (through
  the plugin named `http`, method defaulting to `GET`; the plugin encodes the body: a `FormData` as
  `multipart/form-data` for uploads, a `Blob` with its type, strings and bytes as is, other values as
  JSON; `cookies` and `signedCookies` (signed by the plugin with its current secret) are forwarded
  to the plugin, which validates them), `get`, `close()` (idempotent), `[Symbol.asyncDispose]`,
  `app`, `container`. `inject()` resolves with `{ status, headers, body, bytes, cookies, json() }`
  (`bytes`: the raw body, derived from `body` when the plugin returns none; `cookies`: the parsed
  `set-cookie` headers by name, `SetCookieInfo`, `{}` when the plugin returns none).
  `injectStream(request)` and `injectSse(request)` (method defaulting to `GET`, plus an optional
  `signal`) delegate structurally to the `injectStream` / `injectSse` of the plugin named `http`
  (§9.1: the response at its headers with a `ReadableStream` body; an event stream read in memory
  like `EventSource`); a plugin without them is ZNIGHT001, hinting to register
  `HttpPlugin.configure({ adapter })` from `@znight/http` ≥ 0.1.0 (the release of `@znight/testing`).
  Default logger: console at `warn`.
- Metadata helpers for hand-written tests: `createMetadata(record)`, `defineTestMetadata(spec)`
  (class-first, tokens `test#Name`), `testToken`, `override(key, value)`, `overrideFactory(key,
  factory, { deps, scope, async, dispose })`.

## 11. CLI (`@znight/cli`)

| Command                       | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `znight new [name]`           | Scaffold a project, interactively or from `-y/--yes`, `--pm <bun\|npm\|pnpm\|yarn>` (default: the package manager running the CLI, else `bun` under Bun, else `npm`), `--adapter <node\|fastify\|express\|hono>` (default `node`), `--features <config,observability,messaging,schedule,openapi\|all\|none>` (default `config,observability`; `schedule` adds `SchedulePlugin` before `HttpPlugin`, a sample job and its test on a virtual clock; `openapi` adds `OpenApiPlugin` after `HttpPlugin`, `src/api.ts` with `@OpenApiDocument` and the `openapi` / `openapi:check` scripts), `--no-install`, `--no-git`, `--dir`, `--force`; `.` scaffolds into the current directory. Bun projects test with `bun test` + preload, others with Vitest, and run the application on Bun (`dev` / `start` scripts with `--runtime bun`: `bun run` honours the `node` shebang of the binary); the compiler options live in `znight.config.ts`, imported by `vite.config.ts` (`znight(options)`) and read by the preload and `znight generate`; the `TestApp` test configures `ObservabilityPlugin` with `metrics: { server: false }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `znight generate`             | Write the generated container (compiler `generate`); `--check` (exit 1 when stale, never writes; names every missing or out-of-date file, the module first, then the library manifest in library mode: the compiler's `staleFiles` when it reports them, else a comparison of the outputs with the disk), `-w/--watch` (incremental), `--root`, `--config`, `--config-loader <bundle\|runner\|native>`. Compiler options: `znight.config.*` / `ZNIGHT_CONFIG` (`loadZnightConfig()`, Vite not loaded; skipped with `--config`), else the options the `znight()` plugin compiles with: the Vite config is resolved like `znight build` does (`vite.resolveConfig`, `NODE_ENV` restored afterwards) and the CLI reads `plugin.api.options` (or `api.getOptions()`) with the `root`, `aliases` and `runtimeConditions` of `plugin.api.compiler.options` (without it, the Vite root and the string `resolve.alias` entries), else the defaults. Compiles in `serve` mode. `--watch` watches what the Vite plugin and the Bun preload watch: the `include` directories of the project and of its source libraries, the project root and the directories of `watchFiles`, recomputed after each compile (one watcher per target, real POSIX paths); only changes that can change the result compile (parseable sources, `.js` included; resolution config files; known files), and a directory created, deleted or moved under an include root triggers a rescan (`mv src/users src/accounts` → the old files removed, the new directory added). Stops on `SIGINT`, `SIGTERM`, `SIGHUP` and, on POSIX, `SIGQUIT` |
| `znight g <schematic> <name>` | `service`, `controller`, `consumer`, `config`, `guard` (with a commented `static enforces` line for route decisions), `interceptor` (`--aop` for a method interceptor), `factory`, `job` (`j`: `<name>.jobs.ts` with a `<Name>Jobs` class and a `@Cron` method named `<qualified>.daily`, where `<qualified>` is the directories of the file relative to `src/` (or to the project root for a `--path` outside it) and the kebab name, without the directory named after it: `g job reports/digest` → `reports.digest.daily`, `--path src/emails` → `emails.digest.daily`, so job names stay unique); `--path`, `--flat`, `-f/--force`, `-d/--dry-run`, `--root`. Aliases `generate <schematic>` and `generate:<schematic>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `znight dev`                  | `vite build --watch` (no Vite dev server) and a full process restart after every successful rebuild — no partial HMR of providers: SIGTERM, `--kill-timeout` (5 000 ms) then SIGKILL, `--debounce`d (100 ms) and never overlapping restarts; a failed build keeps the last good process, and so does a failed compilation: the watch build succeeds with the error module, so the CLI reads `plugin.api.result.ok` of `znight()` once the bundle is written, does not restart (a pending restart is cancelled) and reports `Compilation failed` (printing the diagnostics itself with `--log-level silent`). Termination: `SIGINT` (Ctrl+C), `SIGTERM`, `SIGHUP` (terminal closed: nothing more is printed) and, on POSIX, `SIGQUIT` close the watcher and stop the application gracefully (`SIGINT` after Ctrl+C, `SIGTERM` otherwise); a second signal kills it (130). The application runs detached, in its own session and process group, so it receives exactly one signal and never the terminal's. It runs with `NODE_ENV=development` unless the variable was set when the CLI started (the environment is copied before Vite, whose build sets `NODE_ENV`, runs). Also `--runtime <auto\|node\|bun>` (`auto`: the runtime running the CLI, i.e. Node.js under `bun run` / `bunx`, whose `node` shebang Bun honours: pass `--runtime bun`), `--entry` (default: the entry chunk of the build), `--inspect`, `--clear`, `--mode` (`development`), `--log-level` (`warn`), `--root`, `--config`, `--config-loader`; arguments after `--` go to the application                                       |
| `znight build`                | `vite build` with the Vite config (`--mode` default `production`, `--log-level`, `--root`, `--config`, `--config-loader`); compiler errors fail the build. `--openapi[=<path>]` adds the `openapi()` Vite plugin of `@znight/openapi` when the config registers none: the document is emitted after the bundle, to `dist/openapi.json` or the given path; `--openapi-prefix <path>` (with `--openapi` only, else a usage error; a path starting with `/`) passes the HTTP prefix of `HttpPlugin`, the `servers` default of the document, like `znight openapi --prefix`; when the Vite config registers its own `openapi()`, `--openapi=<path>` and `--openapi-prefix` do not apply and a warning says so. `build`, `dev` and `generate` resolve the Vite root like the Vite CLI run in the project directory: the `root` of the config file, relative to the project root (`--root`), set by a `config` hook in `order: 'pre'` (an inline `root` would override the config file's), else the project root; the config file is searched in the project root, in Vite's order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `znight start`                | Run the build (`--entry`, default `dist/main.js` then `dist/main.mjs`; `--runtime <auto\|node\|bun>`; arguments after `--` go to the application) with `NODE_ENV` defaulting to `production`; when the runtime running the CLI provides `process.execve` (POSIX), the CLI `execve`s into the application runtime (same PID, signals, exit code), otherwise it forwards `SIGINT`, `SIGTERM` and `SIGHUP` and returns the child's code (`128 + n` on signal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `znight openapi`              | Write the OpenAPI document of the application with `@znight/openapi` (`emitOpenApi`, §9.5): `-o/--output <file>` (repeatable, default `openapi.json`; `.yaml` / `.yml` write YAML), `--check` (exit 1 when an output is missing or stale, never writes), `--prefix` (the `servers` default), `--runtime <auto\|node\|bun>` (the runtime loading the application modules in a child process), `--converters <file>` (a module default-exporting `SchemaConverter[]`), `--root`, `--config`, `--config-loader`. Compile errors are printed and exit 1 before any module runs; outputs are written only when they change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Global: `--help`, `--version`, `--color`/`--no-color` (`NO_COLOR`, `FORCE_COLOR`), `--debug`
(`ZNIGHT_DEBUG=1`). Exit codes: 0 success, 1 failure, 2 usage error (with a suggestion), 130
cancelled. `vite`, `@znight/compiler` and `@znight/openapi` are **optional** peers (so
`npx @znight/cli new` installs none of them); commands needing them fail with a clear error when
they are missing. The programmatic API
(`main(argv, options)`, `renderProject`, `planSchematic`, `SCHEMATICS`, `AppSupervisor`) takes
injectable services and never throws.

## 12. Release

Every `@znight/*` package is versioned in lockstep (§2, a `fixed` Changesets group) and packed with
`bun pm pack`, which rewrites the `workspace:` and `catalog:` ranges. The process, detailed in
[`RELEASING.md`](https://github.com/znight-org/znight/blob/main/RELEASING.md):

- every change reaches `main` through a pull request whose CI passes (lint, typecheck, build and
  pack, unit and example tests, docs build, end-to-end, Docker integration and packed-tarball smoke
  tests on Node.js 24 and Bun); user-facing changes carry a changeset;
- changesets on `main` feed a "chore: version packages" pull request (versions and changelogs);
- merging it runs CI on that commit, like every push to `main`, then publishes the versions missing from npm
  after an approval in the `npm` environment (an npm token, with provenance), tags
  `vX.Y.Z`, creates the GitHub release and deploys the documentation site to GitHub Pages;
- the release script refuses tarballs that are incomplete (README, LICENSE, `dist`, `exports`
  targets, `bin` shebangs), that keep a `workspace:` or `catalog:` range, or whose versions differ.
