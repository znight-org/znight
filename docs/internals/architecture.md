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
  testing/        TestBed (auto-mocking), TestApp (e2e), mocks and spies
  cli/            `znight` binary: new, generate, g, dev, build, start
examples/         runnable example applications: rest-api, microservice, worker, monorepo (services + a
                  source provider library); each has its own tests (`bun run test:examples`)
tests/            repository-wide tests: boundaries (§2), golden test of the examples (§4.1)
docs/             VitePress documentation site (this file is rendered under /contributing/)
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
    runtime lives in import-free modules (`@znight/config` `conventions.ts`/`coerce.ts`,
    `@znight/http` `path.ts`) or is duplicated in one and kept equal by a test (`@znight/messaging`
    retry constants);
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

| Code      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Severity                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| ZNIGHT001 | Missing provider for a required dependency (a warning for library dependencies in library mode)                                                                                                                                                                                                                                                                                                                                                                  | error                                   |
| ZNIGHT002 | Circular dependency (over the full edge set except `Lazy` and extension edges, prints the cycle, hints at `Lazy<T>`)                                                                                                                                                                                                                                                                                                                                             | error                                   |
| ZNIGHT003 | Scope mismatch: a singleton depends (directly, through transients, multi, guards, interceptors, extension edges or externals) on a request-scoped provider                                                                                                                                                                                                                                                                                                       | error                                   |
| ZNIGHT004 | Duplicate provider for the exact same type without qualifier/`@Primary`                                                                                                                                                                                                                                                                                                                                                                                          | error                                   |
| ZNIGHT005 | Invalid decorator usage (target, arguments, unexported reference, non-public/`#private`/static handler or `@Provides`, abstract or unbound generic provider, provider exported as a type only, class registered by several provider decorators, decorator applied twice, `@Provides` outside `@Factory` or without concrete return type, parameter decorator imported from another feature package; warnings: composite decorator, `const` alias of a decorator) | error / warning                         |
| ZNIGHT006 | Missing or invalid required configuration value, failing config loader (runtime)                                                                                                                                                                                                                                                                                                                                                                                 | error                                   |
| ZNIGHT007 | Invalid route (path grammar, duplicate method+path, `:param` without `@Param` and vice versa, non-coercible param type)                                                                                                                                                                                                                                                                                                                                          | error                                   |
| ZNIGHT008 | Ambiguous injection (several candidates for an interface / base type, ambiguous display name at runtime)                                                                                                                                                                                                                                                                                                                                                         | error                                   |
| ZNIGHT009 | Invalid lifecycle hook (required params, static; on a non-singleton → warning; dispose hooks or `@Provides({ dispose })` on a transient → warning)                                                                                                                                                                                                                                                                                                               | error / warning                         |
| ZNIGHT010 | Unresolvable injection type (missing/opaque annotation, primitive without qualifier, unresolvable import, unanalysable inherited constructor); import casing mismatch, unresolvable library (warnings)                                                                                                                                                                                                                                                           | error / warning                         |
| ZNIGHT011 | Invalid message consumer (no handler, several default handlers, duplicate types, shadowed `*` patterns, invalid retry or consumer options, undecorated parameter, invalid `@OnError`, several consumer classes for one queue; at boot: a retry policy the driver cannot honour, invalid `MessagingPlugin` options)                                                                                                                                               | error                                   |
| ZNIGHT012 | Invalid config class (unsupported property type, config decorator outside `@Config`, duplicate env names or key paths, invalid name/key/prefix, `@Default` not matching the type, constructor with required parameters; invalid `ConfigPlugin` options or config metadata at runtime)                                                                                                                                                                            | error                                   |
| ZNIGHT013 | Request-scoped provider resolved outside of a request scope (runtime)                                                                                                                                                                                                                                                                                                                                                                                            | error                                   |
| ZNIGHT014 | Async factory on a non-singleton provider                                                                                                                                                                                                                                                                                                                                                                                                                        | error                                   |
| ZNIGHT015 | Provider instantiation failed (runtime; carries dependency path, source, cause)                                                                                                                                                                                                                                                                                                                                                                                  | error                                   |
| ZNIGHT016 | Container sealed: register/override after `init()` (runtime)                                                                                                                                                                                                                                                                                                                                                                                                     | error                                   |
| ZNIGHT017 | Unvalidated input: non-primitive `@Body`/`@Query`/`@Message` without schema                                                                                                                                                                                                                                                                                                                                                                                      | warning (error with `strictValidation`) |
| ZNIGHT018 | Version mismatch or broken contract: metadata version, `@znight/*` release-line skew, extension `apiVersion`, malformed `package.json#znight` or compiled-library entry (skipped), untrusted (warning), failing or misbehaving compiler extension, generated-code syntax error                                                                                                                                                                                   | error / warning                         |
| ZNIGHT019 | Unused provider (unreachable from roots, see `prune`)                                                                                                                                                                                                                                                                                                                                                                                                            | warning (only with `reportUnused`)      |
| ZNIGHT020 | The generated module is imported (transitively) by a provider module (ESM cycle → TDZ crash), also through a path alias before the file exists                                                                                                                                                                                                                                                                                                                   | error                                   |
| ZNIGHT021 | Lifecycle hook, plugin hook or shutdown step failed or timed out (runtime)                                                                                                                                                                                                                                                                                                                                                                                       | error                                   |
| ZNIGHT022 | Syntax error: a scanned source file could not be parsed (reported first; the file is skipped, analysis continues)                                                                                                                                                                                                                                                                                                                                                | error                                   |

Singleton → transient is allowed (the singleton owns its instance). Error codes and descriptions
live in `@znight/core` (`ErrorCode`, `ERROR_DESCRIPTIONS`), shared by compiler and runtime.

ZNIGHT019 roots: extension providers, providers with `onStart`/`onReady`/`onStop`, and classes
referenced as values in application code (outside types, imports, decorators and `extends`); a
reference to an alias key counts for the aliased provider. **Impl.** string lookups
(`container.get('X')`) are not seen.

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

| Decorator                                                                            | Target                                                                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@Controller(path? \| { path?, scope? })`                                            | class (provider, default singleton)                                                            |
| `@Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All(path?)`                          | method (several per method allowed)                                                            |
| `@Param(name?, schema?)` `@Query(name?, schema?)` `@Body(schema?)` `@Headers(name?)` | param                                                                                          |
| `@Req()` `@Res()` `@Ctx()`                                                           | param (raw request, raw response — adapter-specific escape hatch, warning — and `HttpContext`) |
| `@HttpCode(status)` `@Header(name, value)`                                           | method                                                                                         |
| `@UseGuard(...guards)` `@UseInterceptor(...interceptors)`                            | class / method (value refs, variadic)                                                          |
| `@Validate(schema)`                                                                  | method — sugar for `@Body(schema)`; using both is ZNIGHT005                                    |
| `@UploadedFile(field?, opts?)` `@UploadedFiles(field?, opts?)`                       | param — static (below)                                                                         |
| `@BodyLimit(size)`                                                                   | class / method — static `ByteSize` (bytes, `'10mb'`, `Infinity`); the method wins              |
| `createRouteDecorator<T>(key)`                                                       | user-defined metadata decorators (`@Roles('admin')`, `@Public()`) → `route.meta[key]`          |

Upload parameters: `field` (static string, absent = files of every field) and options (static
`{ required?, maxSize?, mimeTypes? }`, plus `maxFiles?` for `@UploadedFiles`; `maxSize` is a
`ByteSize`, `kb` = 1024). `@UploadedFile` is typed `File` (or `Blob`; `node:buffer` types are cast),
`@UploadedFiles` `File[]`; `required` defaults to `true` unless the parameter is optional
(`file?: File`, `File | undefined`). Each field is read by one parameter, and a parameter without
field cannot be combined with other upload parameters (ZNIGHT005); upload parameters on a `GET`,
`HEAD`, `DELETE` or `OPTIONS` route are a ZNIGHT005 warning. `@Body()` on an upload route receives
the text fields.

**Impl.** routes are not inherited: route decorators on a class without `@Controller` (e.g. a base
class) are ZNIGHT005; a route decorator created in a `.d.ts` (its key is not readable) is ZNIGHT005.

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
  --> src/notification/notification.service.ts:12:5
   |
12 |     private readonly email: EmailService,
   |                             ^^^^^^^^^^^^
   = hint: Add @Injectable() to EmailService (src/email/email.service.ts:3)
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
  `bindInjection` requests, and the data stored by extensions. Identities are translated to the
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
  closure, `lifecycle`, `decorated`, `declaration`.
- `DecoratorInfo`: `{ identity, name, owner, args: ArgInfo[], called, target, location, node }`;
  `ParameterInfo`: `{ name, index, type, optional, hasDefault, rest, decorators, location,
  typeLocation, property }`.
- `ArgInfo`: `{ kind, evaluated, value?: StaticValue, ref?: ValueRef, error?, location, text, node }`
  (`evaluated` distinguishes an evaluated `undefined` from a non-evaluable argument).
- `AnalyzeContext`: `extension`, `project`, `options`, `types` (`format`, `serialize`, `equals`,
  `stripNullish`, `awaited`), `registerProvider(cls, { scope?, name?, primary?, factory? }) → Token`
  (a class registered by two decorators is ZNIGHT005), `resolveClassRef(arg | ValueRef, { from?,
  role? }) → ClassRef | undefined` (auto-registers injectable helper classes such as guards),
  `bindInjection(request, { from? }) → BindingHandle` (read back with `binding(handle)`),
  `addDependency(from, to, { location?, reason? })`, `classInfo(identity)`, `report(diagnostic)`,
  `store(data)` (appended, read back as `stored`).
- **Extension edges** (`addDependency`, `resolveClassRef({ from })`, `bindInjection({ from })`)
  count for ZNIGHT003 and ZNIGHT019/`prune`, never for ZNIGHT002 nor `resolutionOrder`: the plugin
  resolves them at runtime. **Impl.** consequence: a singleton controller using a request-scoped
  guard is reported as ZNIGHT003.
- `CustomFactory`: `{ deps: InjectionRequest[]; async?: boolean; generate(ctx, { cls, deps }):
  GenNode }` — `deps` are bound with §4.7 and passed as nodes (`d[i]`).
- `ValidateContext`: `extension`, `project`, `options`, `types`, `graph` (`ApplicationGraph`),
  `stored`, `provider(token)`, `classInfo(identity)`, `binding(handle)`, `report(diagnostic)`.
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

`@znight/compiler`, `@znight/testing` and `@znight/cli` have no manifest. Subpath exports:
`@znight/http` (`/node`, `/fastify`, `/express`, `/hono`, `/path`, `/compiler`), `@znight/messaging`
(`/memory`, `/rabbitmq`, `/sqs`, `/kafka`, `/compiler`), `@znight/config` (`/compiler`); the CLI has
the `znight` bin.

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

- The three hooks and their event types live in `@znight/core`, so producers and observers share
  them without depending on each other. Event shapes:
  - `HttpRequestEvent`: `method`, `path`, `route` (pattern, `undefined` when unmatched),
    `requestId`, `headers`, `context` (`HttpContext`), `startTime`, `responseHeaders` (mutable),
    `status?`/`error?` (set before `run` resolves);
  - `MessageDeliveryEvent`: `queue`, `type`, `messageId`, `attempt`, `headers`, `consumer`,
    `handler`, `message` (`InboundMessage`), `startTime`, `outcome?` (`ack` / `retry` /
    `dead-letter`), `error?`;
  - `MessagePublishEvent`: `queue`, `type`, `messageId`, `headers` (mutable until `next()`: wrappers
    add trace context), `startTime`, `error?`.
- Listeners are called synchronously in registration order; a failing listener is logged and never
  affects the emitter. Producers call `run` when there are wrappers and `emit` after it when there
  are listeners.
- `run()` resolves with `fn`'s result; values returned by wrappers are ignored; when a wrapper does
  not call `next()`, the operation does not run and `run()` resolves `undefined`.
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
(`http`, `messaging`, `config`, `observability`), and provides the externals declared in its manifest
(§7) during `register`. `HttpPlugin`, `MessagingPlugin` and `ObservabilityPlugin` also accept a
function of the container (§8.2); `ConfigPlugin` only takes an object, since it loads the
configuration in `register`, before any provider exists.

### 9.1 HTTP (`@znight/http`)

```ts
interface HttpMetadata {
  controllers: HttpControllerDefinition[]
}
interface HttpControllerDefinition {
  token
  basePath // normalised, '/' when absent
  guards: Token[]
  interceptors: Token[]
  meta: Record<string, unknown> // createRouteDecorator on the class
  routes: HttpRouteDefinition[]
}
interface HttpRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ALL'
  path: string
  fullPath: string // joinPaths(basePath, path), without the plugin prefix
  handler: string
  status?: number // @HttpCode
  headers?: Record<string, string> // @Header, lower-case names
  meta: Record<string, unknown> // merged over the controller meta at runtime
  guards: Token[]
  interceptors: Token[]
  params: {
    index
    source: 'param' | 'query' | 'body' | 'headers' | 'request' | 'response' | 'context' | 'file' | 'files'
    name? // param / query key / header name / multipart field (file, files)
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
field). `@Body()` on an upload route receives the text fields. Unused `ctx` is omitted.

Pipeline (normative), per request — matched or not:
`container.runInScope({ HttpContext, RequestId }) → hooks.run('http:request', event, () =>
global guards → controller guards → route guards → body parsing (routes with a @Body() or upload
parameter; multipart bodies are parsed as they stream in, upload rules enforced on the fly) →
global/controller/route interceptors (outermost first) → invoke (extract → coerce → validate →
handler) → serialise)`. `@Validate(S)` alone parses the body in `invoke`. Exceptions are mapped to
a response inside `hooks.run` and `event.status` / `event.error` are set before it resolves. The
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
  (400 otherwise, `details.expected`), each `maxSize` / `maxFiles` (413), `mimeTypes` (415, compared
  with the declared type) is enforced while reading; a second file for `@UploadedFile` → 400;
  non-multipart non-empty bodies → 415. Other routes accept files of any field within the plugin
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
  `details: [{ path, message }]`; other errors → `{ statusCode: 500, error: 'Internal Server Error' }`
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
- `HttpPlugin.configure({ adapter, port, host, prefix, guards, interceptors, exceptionMappers,
  trailingSlash, exposeErrors, bodyLimit, uploads, requestIdHeader, generateRequestId,
  drainTimeoutMs })` (defaults: built-in `nodeAdapter()`, `3000`, `0.0.0.0`, `strict`, `false`,
  1 MiB, the upload limits above, `x-request-id`, 4 000 ms); class refs are resolved with
  `container.tokenOf`. The instance exposes `inject`, `address`, `routes`, `adapter`, `inflight`
  and `initRoots()` (the classes of its `guards`, `interceptors` and `exceptionMappers` options,
  `[]` when the options are a function of the container: the `PluginInitRoots` contract of §10).
  A plugin instance serves one application at a time (it can serve another one once the previous
  application stopped; registering it in a second running application is ZNIGHT004 "Call
  HttpPlugin.configure() once per application"); an adapter instance serves a single application
  (bootstrapping it again is ZNIGHT021: create adapters per application, e.g.
  `HttpPlugin.configure(() => ({ adapter: fastifyAdapter() }))`).
- Lifecycle: `register` declares the request-scoped externals; `onBootstrap` resolves options and
  registers routes (ZNIGHT007 / ZNIGHT001 at boot); `onStart` listens; `onStop` drains: stops
  accepting connections, closes idle ones, answers with `connection: close`, waits for in-flight
  requests (streamed and file responses included) up to `drainTimeoutMs` (keep it below
  `hookTimeoutMs`; `Infinity`: no limit of its own, no timer; a finite value is capped at the timer
  range, 2^31 − 1 ms), then force-closes; `onDispose` closes the adapter.

```ts
interface HttpAdapter {
  name: string // ctx.adapter
  registerRoute(route: { method; path: RoutePath; handler: AdapterHandler }): void // ALL expanded, HEAD added
  setFallbackHandler(handler: FallbackHandler): void // unmatched requests and framework errors
  listen(port: number, host: string): Promise<HttpServerAddress> // port 0 = free port
  close(options?: { force?: boolean }): Promise<void> // graceful drain, or destroy connections
  inject(request: InjectRequest): Promise<InjectResponse> // in-memory, same pipeline
}
```

```ts
interface AdapterRequest {
  method
  url
  headers
  ip
  raw
  rawResponse
  readBody(limit: number): Promise<Uint8Array> // once; 413 past the limit (content-length first)
  streamBody?(limit: number): ReadableStream<Uint8Array> // pull-based, 413 past the limit, 400 on abort
  hasBody?(): boolean // asked only without content-length / transfer-encoding; false over HTTP/1.1
  rawStatus?(): number | undefined // status written through @Res()
}
type ReplyBody = Uint8Array | ReadableStream<Uint8Array> | Blob | null // the plugin sends no Blob
interface AdapterReply {
  status
  headers // lower-case names, validated: every name and value can be sent
  body: ReplyBody // bytes, a stream (files too) or null
  blob?: Blob // the file `body` streams, for adapters able to send it natively
  raw?: boolean
}
interface InjectRequest {
  method
  url
  headers?
  body?
  query?
} // body: string | bytes | FormData | Blob | JSON value
interface InjectResponse {
  status
  headers: Record<string, string | string[]> // repeats joined with ", "; set-cookie: an array
  body: string
  bytes: Uint8Array
  json<T>(): T
}
```

Adapters only route and translate I/O; everything else is done by the plugin so every adapter
behaves the same. An adapter without `streamBody` gets multipart uploads buffered before parsing. A
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
opens it at once, and the scope closes then.

`inject` is in-memory (fastify `inject`, hono `request`, node and express via `light-my-request`, an
optional peer): strings and bytes are sent as is (`text/plain` / `application/octet-stream` without
`content-type`), a `FormData` as `multipart/form-data` (boundary from the Fetch API encoding), a
`Blob` / `File` with its type, other values as JSON; the response has the UTF-8 `body` and the raw
`bytes` (downloads); `headers` holds lower-case names, repeated headers joined with `, ` except
`set-cookie`, always an array (one entry per cookie: cookie values may contain `, `). Subpaths:
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
metrics, spans with W3C trace-context) and `messaging:publish` (producer span, trace context
injected into the message headers). Each part can be turned off: `metrics: false`, `tracing: false`,
`logging.requests` / `logging.messages: false`, and per hook (`tracing.http`, `metrics.messaging`...).
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
  externals, `extensions.config` / `http` / `messaging`) and does not depend on the feature packages.
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
  message consumers, the override keys and the **plugin roots** (everything when there is no
  controller nor consumer; `only: 'all' | keys`, keys to which the override keys and plugin roots
  are added; `'all'` ignores plugin roots). Plugin roots are the providers a plugin resolves in
  `onBootstrap` although the metadata does not reference them (`HttpPlugin`'s global `guards`,
  `interceptors`, `exceptionMappers`): contract `PluginInitRoots`, an optional
  `initRoots(): readonly ProviderKey[]` method of a plugin, called once before `Application.create`
  (it SHOULD NOT throw: invalid options are reported by `onBootstrap`; a non-array result is a
  `TypeError` naming the plugin); keys that designate
  providers of the metadata are added, others are left to the plugin to report. Options computed
  from the container cannot be listed (`HttpPlugin` returns `[]` then): when such a provider has an
  async dependency, the boot fails with ZNIGHT015 ("on demand: its factory is async") and TestApp
  adds the hint to list it in `only` (or pass `only: 'all'`).
  It starts the app unless `start: false` (so pass `port: 0`). Members: `inject(request)` (through
  the plugin named `http`, method defaulting to `GET`; the plugin encodes the body: a `FormData` as
  `multipart/form-data` for uploads, a `Blob` with its type, strings and bytes as is, other values as
  JSON), `get`, `close()` (idempotent), `[Symbol.asyncDispose]`, `app`, `container`. `inject()`
  resolves with `{ status, headers, body, bytes, json() }` (`bytes`: the raw body; derived from
  `body` when the plugin returns none). Default logger: console at `warn`.
- Metadata helpers for hand-written tests: `createMetadata(record)`, `defineTestMetadata(spec)`
  (class-first, tokens `test#Name`), `testToken`, `override(key, value)`, `overrideFactory(key,
  factory, { deps, scope, async, dispose })`.

## 11. CLI (`@znight/cli`)

| Command                       | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `znight new [name]`           | Scaffold a project, interactively or from `-y/--yes`, `--pm <bun\|npm\|pnpm\|yarn>` (default: the package manager running the CLI, else `bun` under Bun, else `npm`), `--adapter <node\|fastify\|express\|hono>` (default `node`), `--features <config,observability,messaging\|all\|none>` (default `config,observability`), `--no-install`, `--no-git`, `--dir`, `--force`; `.` scaffolds into the current directory. Bun projects test with `bun test` + preload, others with Vitest, and run the application on Bun (`dev` / `start` scripts with `--runtime bun`: `bun run` honours the `node` shebang of the binary); the compiler options live in `znight.config.ts`, imported by `vite.config.ts` (`znight(options)`) and read by the preload and `znight generate`; the `TestApp` test configures `ObservabilityPlugin` with `metrics: { server: false }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `znight generate`             | Write the generated container (compiler `generate`); `--check` (exit 1 when stale, never writes; names every missing or out-of-date file, the module first, then the library manifest in library mode: the compiler's `staleFiles` when it reports them, else a comparison of the outputs with the disk), `-w/--watch` (incremental), `--root`, `--config`, `--config-loader <bundle\|runner\|native>`. Compiler options: `znight.config.*` / `ZNIGHT_CONFIG` (`loadZnightConfig()`, Vite not loaded; skipped with `--config`), else the options the `znight()` plugin compiles with: the Vite config is resolved like `znight build` does (`vite.resolveConfig`, `NODE_ENV` restored afterwards) and the CLI reads `plugin.api.options` (or `api.getOptions()`) with the `root`, `aliases` and `runtimeConditions` of `plugin.api.compiler.options` (without it, the Vite root and the string `resolve.alias` entries), else the defaults. Compiles in `serve` mode. `--watch` watches what the Vite plugin and the Bun preload watch: the `include` directories of the project and of its source libraries, the project root and the directories of `watchFiles`, recomputed after each compile (one watcher per target, real POSIX paths); only changes that can change the result compile (parseable sources, `.js` included; resolution config files; known files), and a directory created, deleted or moved under an include root triggers a rescan (`mv src/users src/accounts` → the old files removed, the new directory added). Stops on `SIGINT`, `SIGTERM`, `SIGHUP` and, on POSIX, `SIGQUIT` |
| `znight g <schematic> <name>` | `service`, `controller`, `consumer`, `config`, `guard`, `interceptor` (`--aop` for a method interceptor), `factory`; `--path`, `--flat`, `-f/--force`, `-d/--dry-run`, `--root`. Aliases `generate <schematic>` and `generate:<schematic>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `znight dev`                  | `vite build --watch` (no Vite dev server) and a full process restart after every successful rebuild — no partial HMR of providers: SIGTERM, `--kill-timeout` (5 000 ms) then SIGKILL, `--debounce`d (100 ms) and never overlapping restarts; a failed build keeps the last good process, and so does a failed compilation: the watch build succeeds with the error module, so the CLI reads `plugin.api.result.ok` of `znight()` once the bundle is written, does not restart (a pending restart is cancelled) and reports `Compilation failed` (printing the diagnostics itself with `--log-level silent`). Termination: `SIGINT` (Ctrl+C), `SIGTERM`, `SIGHUP` (terminal closed: nothing more is printed) and, on POSIX, `SIGQUIT` close the watcher and stop the application gracefully (`SIGINT` after Ctrl+C, `SIGTERM` otherwise); a second signal kills it (130). The application runs detached, in its own session and process group, so it receives exactly one signal and never the terminal's. It runs with `NODE_ENV=development` unless the variable was set when the CLI started (the environment is copied before Vite, whose build sets `NODE_ENV`, runs). Also `--runtime <auto\|node\|bun>` (`auto`: the runtime running the CLI, i.e. Node.js under `bun run` / `bunx`, whose `node` shebang Bun honours: pass `--runtime bun`), `--entry` (default: the entry chunk of the build), `--inspect`, `--clear`, `--mode` (`development`), `--log-level` (`warn`), `--root`, `--config`, `--config-loader`; arguments after `--` go to the application                                       |
| `znight build`                | `vite build` with the Vite config (`--mode` default `production`, `--log-level`, `--root`, `--config`, `--config-loader`); compiler errors fail the build. `build`, `dev` and `generate` resolve the Vite root like the Vite CLI run in the project directory: the `root` of the config file, relative to the project root (`--root`), set by a `config` hook in `order: 'pre'` (an inline `root` would override the config file's), else the project root; the config file is searched in the project root, in Vite's order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `znight start`                | Run the build (`--entry`, default `dist/main.js` then `dist/main.mjs`; `--runtime <auto\|node\|bun>`; arguments after `--` go to the application) with `NODE_ENV` defaulting to `production`; when the runtime running the CLI provides `process.execve` (POSIX), the CLI `execve`s into the application runtime (same PID, signals, exit code), otherwise it forwards `SIGINT`, `SIGTERM` and `SIGHUP` and returns the child's code (`128 + n` on signal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Global: `--help`, `--version`, `--color`/`--no-color` (`NO_COLOR`, `FORCE_COLOR`), `--debug`
(`ZNIGHT_DEBUG=1`). Exit codes: 0 success, 1 failure, 2 usage error (with a suggestion), 130
cancelled. `vite` and `@znight/compiler` are **optional** peers (so `npx @znight/cli new` installs
neither); commands needing them fail with a clear error when they are missing. The programmatic API
(`main(argv, options)`, `renderProject`, `planSchematic`, `SCHEMATICS`, `AppSupervisor`) takes
injectable services and never throws.

## 12. Release

Planned (not set up yet): Changesets with a `fixed` group (lockstep versions). CI packs with
`bun pm pack` (rewrites `workspace:`/`catalog:`) and publishes the tarballs with
`npm publish --provenance` (OIDC trusted publishing). A smoke test installs the packed tarballs into
a clean app and runs it on Node 24 and Bun.
