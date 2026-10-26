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
examples/         runnable example applications (planned; the workspace glob is reserved)
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

Each package has `tsconfig.json` (sources, strict library settings) and `test/tsconfig.json` (tests,
Bun types, decorators allowed). `typecheck` runs both.

### Package conventions

- `src/index.ts` is the public runtime entry. Additional entries (`src/compiler/index.ts`,
  `src/adapters/fastify.ts`...) are declared in `tsdown.config.ts` **and** `package.json#exports`
  with the same `@znight/source` / `types` / `default` triple.
- Tests: `packages/<pkg>/test/**/*.test.ts` with `bun:test`; fixtures in `test/fixtures/`.
  Broker integration tests run only with `ZNIGHT_INTEGRATION=1`, the CLI end-to-end test only with
  `ZNIGHT_CLI_E2E=1`.
- Third-party integrations (fastify, amqplib, pino...) are **optional peer dependencies** (plus exact
  devDependencies for tests) unless the package cannot work without them. Adapters and drivers live
  in subpath exports, so their clients are only loaded when used; optional peers needed by a root
  entry (`yaml`, the AWS SDK, `prom-client`, `pino-pretty`) are loaded lazily (non-literal dynamic
  import, or `createRequire` for CommonJS peers), so bundlers never require an absent peer. Runtime
  `dependencies`/`peerDependencies` use caret ranges.
- Boundaries (enforced by the packages' own tests):
  - `<pkg>/compiler` entries only `import type` from `@znight/compiler` and never import the
    package's runtime entry (so building never loads fastify, amqplib...); constants they share with
    the runtime are duplicated in an import-free module and kept equal by a test;
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
  'dev' | 'always' | false`). `source.file` is relative to the project root for application files
  and `<package>/<path in the package>` for package files (independent of symlinks and of the
  `node_modules` layout).
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
  ZNIGHT005 with the fix-it "export it".

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
  (`type UserRepo = Repository<User>`); recursive aliases are opaque;
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
decorator gets a ZNIGHT005 warning ("composite decorators are not visible to the compiler").

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
   injection); optional (`?`, `| undefined`, `| null`, default value, `@Optional()`) →
   `{ token, optional: true }` where the token is the identity (the qualifier for a primitive); else
   ZNIGHT001.
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
No alias is emitted for `globalThis#*` nor for the core marker types (`Lazy`, `OnStart`, `OnReady`,
`OnStop`, `MethodInterceptor`).

### 4.8 Validations

| Code      | Meaning                                                                                                                                                                                                                                                                                                                     | Severity                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| ZNIGHT001 | Missing provider for a required dependency (a warning for library dependencies in library mode)                                                                                                                                                                                                                             | error                                   |
| ZNIGHT002 | Circular dependency (over the full edge set except `Lazy` and extension edges, prints the cycle, hints at `Lazy<T>`)                                                                                                                                                                                                        | error                                   |
| ZNIGHT003 | Scope mismatch: a singleton depends (directly, through transients, multi, guards, interceptors, extension edges or externals) on a request-scoped provider                                                                                                                                                                  | error                                   |
| ZNIGHT004 | Duplicate provider for the exact same type without qualifier/`@Primary`                                                                                                                                                                                                                                                     | error                                   |
| ZNIGHT005 | Invalid decorator usage (target, arguments, unexported reference, non-public/`#private`/static handler or `@Provides`, abstract or unbound generic provider, class registered by several provider decorators, decorator applied twice, `@Provides` outside `@Factory` or without concrete return type, composite decorator) | error / warning                         |
| ZNIGHT006 | Missing or invalid required configuration value, failing config loader (runtime)                                                                                                                                                                                                                                            | error                                   |
| ZNIGHT007 | Invalid route (path grammar, duplicate method+path, `:param` without `@Param` and vice versa, non-coercible param type)                                                                                                                                                                                                     | error                                   |
| ZNIGHT008 | Ambiguous injection (several candidates for an interface / base type, ambiguous display name at runtime)                                                                                                                                                                                                                    | error                                   |
| ZNIGHT009 | Invalid lifecycle hook (required params, static; on a non-singleton → warning; dispose hooks or `@Provides({ dispose })` on a transient → warning)                                                                                                                                                                          | error / warning                         |
| ZNIGHT010 | Unresolvable injection type (missing/opaque annotation, primitive without qualifier, unresolvable import, unanalysable inherited constructor); import casing mismatch, unresolvable library (warnings)                                                                                                                      | error / warning                         |
| ZNIGHT011 | Invalid message consumer (no handler, several default handlers, duplicate types, shadowed `*` patterns, invalid retry or consumer options, undecorated parameter, invalid `@OnError`, several consumer classes for one queue; at boot: a retry policy the driver cannot honour)                                             | error                                   |
| ZNIGHT012 | Invalid config class (unsupported property type, config decorator outside `@Config`, duplicate env names or key paths, invalid name/key/prefix, `@Default` not matching the type, constructor with required parameters; invalid `ConfigPlugin` options or config metadata at runtime)                                       | error                                   |
| ZNIGHT013 | Request-scoped provider resolved outside of a request scope (runtime)                                                                                                                                                                                                                                                       | error                                   |
| ZNIGHT014 | Async factory on a non-singleton provider                                                                                                                                                                                                                                                                                   | error                                   |
| ZNIGHT015 | Provider instantiation failed (runtime; carries dependency path, source, cause)                                                                                                                                                                                                                                             | error                                   |
| ZNIGHT016 | Container sealed: register/override after `init()` (runtime)                                                                                                                                                                                                                                                                | error                                   |
| ZNIGHT017 | Unvalidated input: non-primitive `@Body`/`@Query`/`@Message` without schema                                                                                                                                                                                                                                                 | warning (error with `strictValidation`) |
| ZNIGHT018 | Version mismatch or broken contract: metadata version, `@znight/*` release-line skew, extension `apiVersion`, malformed `package.json#znight`, untrusted (warning), failing or misbehaving compiler extension, generated-code syntax error                                                                                  | error / warning                         |
| ZNIGHT019 | Unused provider (unreachable from roots, see `prune`)                                                                                                                                                                                                                                                                       | warning (only with `reportUnused`)      |
| ZNIGHT020 | The generated module is imported (transitively) by a provider module (ESM cycle → TDZ crash)                                                                                                                                                                                                                                | error                                   |
| ZNIGHT021 | Lifecycle hook, plugin hook or shutdown step failed or timed out (runtime)                                                                                                                                                                                                                                                  | error                                   |
| ZNIGHT022 | Syntax error: a scanned source file could not be parsed (reported first; the file is skipped, analysis continues)                                                                                                                                                                                                           | error                                   |

Singleton → transient is allowed (the singleton owns its instance). Error codes and descriptions
live in `@znight/core` (`ErrorCode`, `ERROR_DESCRIPTIONS`), shared by compiler and runtime.

ZNIGHT019 roots: extension providers, providers with `onStart`/`onReady`/`onStop`, and classes
referenced as values in application code (outside types, imports, decorators and `extends`); a
reference to an alias key counts for the aliased provider. **Impl.** string lookups
(`container.get('X')`) are not seen.

**Impl.** runtime conditions without a dedicated code reuse the closest one: container not
initialised, initialising or disposed → ZNIGHT015; duplicate plugin name → ZNIGHT004; invalid plugin,
shutdown option or dependency reference, async interceptor result for a sync method → ZNIGHT005;
unknown `dispose` method → ZNIGHT021; not a metadata object → ZNIGHT018.

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
| `createRouteDecorator<T>(key)`                                                       | user-defined metadata decorators (`@Roles('admin')`, `@Public()`) → `route.meta[key]`          |

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
// Vite plugin `znight(options?: ZnightOptions)` and '@znight/compiler/bun' preload: §6.3

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
  outFile: string // absolute
  diagnostics: Diagnostic[] // ZNIGHT022 first, then sorted by file and offset
  ok: boolean // no error diagnostic
  graph: ApplicationGraph // pruned with `prune`
  stats: { files: number; providers: number; durationMs: number; parsed: number }
  library: LibraryOutput | undefined // library mode only: znight.providers.json
  watchFiles: string[] // sources, manifests and compiled libraries the result depends on
  decorators: ReadonlyMap<string, { hash; ranges }> // per analysed file, for stripDecorators
}
interface GenerateOptions {
  check?: boolean // never write; report `stale`
}
interface GenerateResult extends CompileResult {
  written: string[] // files whose content changed (none when !ok)
  stale: boolean // check mode: generated files missing or out of date
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

- `compile()` never writes. `generate()` writes the generated module (and
  `dist/znight.providers.json` in library mode) only when its content changed and there is no
  error; with `check` it never writes. `createCompiler()` keeps the parse cache and the loaded
  extensions between compiles; changes to `outFile` are ignored.
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

**Status**: specified, not yet exported by `@znight/compiler` 0.1 (the CLI falls back to a plain
Vite server build meanwhile). `createCompiler()` provides everything they need (incremental
compiles, `decorators`, `watchFiles`, `isOutFile`).

- `znight(options)` is the default and named export; its options are exposed as
  `plugin.api.options` (read by `znight generate`).
- Applies to the server/SSR environment only (`applyToEnvironment`); one compile per process is
  shared across environments.
- `config`: when `app !== false` and the user configured neither `build.ssr` nor `build.lib`:
  `build.ssr = entry`, `build.outDir = 'dist'`, `build.target = 'node24'`, `build.sourcemap = true`,
  `ssr.target = 'node'`.
- `buildStart`: compile. In `build`: errors fail the build and nothing is written. In watch/serve:
  diagnostics are printed and, if there are errors, the generated module is replaced by the error
  module.
- `resolveId`/`load`: the outFile id is served from memory (latest result); the disk copy exists for
  `tsc` and editors and is written only when its content changed. The outFile is ignored by watchers.
- Watching: include roots and every file of `watchFiles` are watched (`addWatchFile`, server
  watcher); file create/unlink re-runs the glob; config files clear the resolver cache; events are
  debounced (~50 ms).
- `transform` (`enforce: 'pre'`): strips exactly the decorator ranges recorded by the last analysis
  of that file content (`result.decorators`, matched by content hash; never re-decides); files not
  analysed are untouched. High-resolution source maps via `magic-string`.
- `@znight/compiler/bun`: a Bun plugin/preload (`bunfig.toml` `preload`) regenerating the module
  before tests and `bun --watch`, with the same stripping.

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
  providers.
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
  resolved with the runtime conditions (plus `@znight/source` when running under Bun). `@znight/*`
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
  synchronous singletons are created on first use, async ones outside the closure are refused.
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
  (e.g. an abstract base behind an alias) falls back to its name, filtered by prototype chain;
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
    timeoutMs?: number // global stop deadline, default 10 000
    hookTimeoutMs?: number // per step, default 5 000
    process?: ProcessLike // injectable for tests
  }
  init?: InitOptions // forwarded to container.init
  hot?: { dispose(cb): void } // pass import.meta.hot: stop() on HMR dispose
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
3. `stop()` (idempotent; waits for an in-progress `start()`): `state = 'stopping'` → plugins
   `onStop` (reverse) → providers `onStop` (only those whose `onStart` ran) + disposal (always,
   reverse resolution order) → plugins `onDispose` (reverse) → `state = 'stopped'` (also when
   `stop()` rejects). Every step is attempted with `hookTimeoutMs` inside the global `timeoutMs`
   deadline; errors are aggregated (`ZnightAggregateError`, ZNIGHT021). Signal listeners are
   removed. Only the signal path sets `process.exitCode` (1 on failure) and a second signal forces
   exit (130).

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

Common rules: each feature plugin is created with `XxxPlugin.configure(options | (container) =>
options)`, has a fixed `name` (`http`, `messaging`, `config`, `observability`), and provides the
externals declared in its manifest (§7) during `register`.

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
    source: 'param' | 'query' | 'body' | 'headers' | 'request' | 'response' | 'context'
    name?
    type? // readable form, only for coerced values
    optional?
    schema?: boolean
  }[] // informational: extraction happens in invoke
  rawResponse?: boolean // @Res()
  invoke: (controller: any, ctx: HttpContext) => unknown
}
```

`invoke` extracts, coerces and validates every argument with the helpers exported by
`@znight/http` (`coerce.string|number|integer|boolean|bigint|date|enum|array|optional`, failures →
400; `validate(schema, value, location)` with any Standard Schema, `await`ed, so the arrow is `async`
only when a schema is used). `@Validate(S)` without `@Body()` generates `await validate(S, await
ctx.parseBody(), 'body')`. Unused `ctx` is omitted.

Pipeline (normative), per request — matched or not:
`container.runInScope({ HttpContext, RequestId }) → hooks.run('http:request', event, () =>
global guards → controller guards → route guards → body parsing (routes with @Body/@Validate) →
global/controller/route interceptors (outermost first) → invoke (extract → coerce → validate →
handler) → serialise)`. Exceptions are mapped to a response inside `hooks.run` and `event.status` /
`event.error` are set before it resolves.

- Path grammar: static segments, `:name` params, trailing `*` wildcard (`ctx.params['*']`); anything
  else ZNIGHT007 (at build time, and at boot for hand-written metadata). Parameters are extracted and
  percent-decoded by Znight from the raw path on every adapter (malformed encoding → 400); the most
  specific route wins (static > param > wildcard). Trailing-slash policy `strict` (default) /
  `ignore` / `redirect` (308) applied on every adapter.
- `HEAD` is served for every `GET` route unless a `@Head` route exists (the Fastify adapter disables
  `exposeHeadRoutes`). `@All` registers the route for GET, HEAD, POST, PUT, PATCH, DELETE and
  OPTIONS, only for methods without an explicit route on the same path. Unknown path → 404; known
  path, other method → 405 with `allow`; unmatched `OPTIONS` → 204 with `allow`. 404/405 go through
  the hooks and the exception mappers.
- Query parsing is done by Znight from the URL (`Record<string, string | string[]>`); coercion to
  `T[]` accepts a single value. Bodies are parsed by Znight (JSON, text, urlencoded, multipart →
  `FormData`, otherwise bytes), up to `bodyLimit` (413), `content-encoding` other than identity → 415;
  other routes read it lazily (`ctx.parseBody()`, `ctx.rawBody()`).
- Files: see [packages/http/README.md#files](../../packages/http/README.md#files).
- Status precedence: `@HttpCode` > `HttpResponse.status` > default (201 for POST, 200 otherwise);
  `undefined` return → empty body (204 unless POST or `@HttpCode`). Objects → JSON, strings → text,
  `Uint8Array`/`ReadableStream` → octet-stream, Web `Response` → sent as is.
- Errors: `HttpException(status, message?, details?, { headers, cause })` and subclasses render
  `{ statusCode, error, message, details? }`; schema failures → 400 (`ValidationException`) with
  `details: [{ path, message }]`; other errors → `{ statusCode: 500, error: 'Internal Server Error' }`
  (message only with `exposeErrors: true`), sent to hooks and the logger. An exception mapper
  returning an `HttpResponse` without status keeps the error's status.
- Handlers receive the schema **output** (defaults, transforms, stripped keys).
- Request ids: the `requestIdHeader` (default `x-request-id`) is reused when the client sends a
  valid one (≤ 128 characters of `[A-Za-z0-9_\-.:@/+=]`) and echoed on every response; `false` always
  generates (`generateRequestId`, default `crypto.randomUUID()`) and never echoes.
- `HttpPlugin.configure({ adapter, port, host, prefix, guards, interceptors, exceptionMappers,
  trailingSlash, exposeErrors, bodyLimit, requestIdHeader, generateRequestId, drainTimeoutMs })`
  (defaults: built-in `nodeAdapter()`, `3000`, `0.0.0.0`, `strict`, `false`, 1 MiB, `x-request-id`,
  4 000 ms); class refs are resolved with `container.tokenOf`. The instance exposes `inject`,
  `address`, `routes`, `adapter`, `inflight`.
- Lifecycle: `register` declares the request-scoped externals; `onBootstrap` resolves options and
  registers routes (ZNIGHT007 / ZNIGHT001 at boot); `onStart` listens; `onStop` drains: stops
  accepting connections, closes idle ones, answers with `connection: close`, waits for in-flight
  requests up to `drainTimeoutMs` (keep it below `hookTimeoutMs`), then force-closes; `onDispose`
  closes the adapter.

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

Adapters only route and translate I/O; everything else is done by the plugin so every adapter
behaves the same. `inject` is in-memory (fastify `inject`, hono `request`, node and express via
`light-my-request`, an optional peer). Subpaths: `@znight/http/node` (built-in, also the root
default), `/fastify`, `/express`, `/hono` (`Bun.serve` on Bun, `@hono/node-server` on Node),
`/path` (path grammar helpers). Request-scoped externals: `HttpContext` (and the branded string
`RequestId`) are provided per request; `HttpPlugin` itself is injectable.

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

- each delivery waits for a concurrency slot, then runs in its own scope (`InboundMessage`
  request-scoped external) through `hooks.run('messaging:message')`: decode → select handler →
  invoke;
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
  or the `x-znight-attempt` header. Boot fails (ZNIGHT011) if a `@Retry` cannot be honoured;
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

Defaults: `concurrency` 1; handlers without `@Retry` use 3 attempts, exponential from 1 s capped at
30 s (`attempts` counts the first delivery).

`MessagingPlugin.configure({ driver, defaults?: { retry?, concurrency?, deadLetter?, requeueDelay? },
codec?, consume? })` (default codec JSON; `consume: false` for publish-only processes):
`register` provides `MessageBroker` (value) and declares `InboundMessage` (request external);
`onBootstrap` validates consumers and retry policies against the driver capabilities, then
connects; `onStart` subscribes (all or nothing); `onStop` stops receiving, aborts in-process retry
waits (messages released), aborts `message.signal`, awaits in-flight handlers; `onDispose` closes
the driver. The instance exposes `broker`, `driver`, `consumers()`.

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

| Driver                         | Attempts                                | Native delay                                        | In-process budget | Dead letters                        | Notes                                                                                                                                        |
| ------------------------------ | --------------------------------------- | --------------------------------------------------- | ----------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/memory`                      | native                                  | timers                                              | 1 s               | `<q>.dlq`                           | deterministic test broker (`send`, `idle`, `settlements`, `deadLetters`, `published`, `fail`...)                                             |
| `/rabbitmq` (amqplib)          | `x-znight-attempt` + `x-delivery-count` | delay queues `<q>.delay.<ms>` (TTL + DLX)           | 5 s               | `<q>.dlq`, publish confirmed + ack  | confirm channel + `mandatory`, `prefetch = concurrency`, default exchange only, topology declared or verified, reconnects                    |
| `/sqs` (client-sqs ^3.600)     | `ApproximateReceiveCount`               | visibility timeout (≤ 12 h)                         | 1 s               | `<q>-dlq` or `RedrivePolicy` target | queues never created; `maxReceiveCount` ≥ attempts checked; lease extension; FIFO groups by `key`                                            |
| `/kafka` (@platformatic/kafka) | `x-znight-attempt`                      | retry topic `<group>.retry` (`x-znight-not-before`) | 0                 | `<topic>.dlq`                       | one consumer group per `@Consumer` (`<groupId>.<topic>`, override with `groupId`), manual commits, partitions sequential, no delayed publish |

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
`ConfigLoaderError` (ZNIGHT006); invalid options or metadata are ZNIGHT012.

Secrets: `@Secret` values are masked (`[REDACTED]`) by non-enumerable `toJSON`, `toString` and
`util.inspect.custom` installed on the instance (methods the class defines are kept) and in error
messages; the property itself keeps the real value. A `ConfigSource` never prints its values.

### 9.4 Observability (`@znight/observability`)

`ObservabilityPlugin.configure({ logging?, metrics?, tracing? })` (name `observability`) provides
`Logger`, `MetricsRegistry`, `Tracer`, `LoggedInterceptor`, `TracedInterceptor`,
`MetricInterceptor`, replaces the core logger (`app.setLogger`, `component: 'znight'`, unless
`logging.replaceCoreLogger: false`) and wraps `http:request` / `messaging:message` (request logs, RED
metrics, spans with W3C trace-context) and `messaging:publish` (producer span, trace context
injected into the message headers). `onStart`/`onStop` start and stop the `/metrics` server
(default port 9464); `onDispose` removes the wrappers, flushes the tracer provider and the logger.

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
  `pino-pretty`), CloudWatch (stdout JSON), Datadog (HTTP intake, batching, retries).
- Metrics (`prom-client`, optional peer) are enabled by default only when it is installed;
  `metrics: false` runs `@Metric` methods unmeasured. HTTP labels use the route pattern (`unmatched`
  when none), never the raw path. `MetricsRegistry` returns the existing metric for the same name and
  throws ZNIGHT005 when type or labels differ.
- Tracing uses `@opentelemetry/api` (spans are recorded by whatever SDK the application registers);
  without a global propagator a built-in W3C `traceparent` propagator is used. 5xx sets the span
  status to `ERROR`.
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

- Metadata freshness: the `@znight/compiler/bun` preload (and the Vite plugin under Vitest)
  regenerate before tests (§6.3).
- `TestBed.create(target, { metadata, provide?, overrides?, config?, mockFn?, deep?, aop? })` →
  `{ instance, mocks, container }`. The target (class, token, `TypedToken`, alias or unique display
  name) is built with its real generated factory (async factories awaited; factory errors →
  ZNIGHT015) and its **direct** dependencies are resolved by kind:

  | Dependency                                                        | Injected                                                                                              |
  | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | class / interface / `@Provides` value / external                  | deep auto-mock                                                                                        |
  | config class (`extensions.config`, read structurally)             | real instance: `new C()`, then defaults, then `config` values (unknown class or property → ZNIGHT012) |
  | qualified value without class (`@Provides({ name })`, primitives) | the `provide` value, else ZNIGHT001                                                                   |
  | optional / multi / `Lazy<T>`                                      | `undefined` / `[]` (plus provided members) / `{ get: () => mock }` (same mock as `mocks.get(T)`)      |
  | interceptor dependencies                                          | not created, interceptors not applied — unless `aop: 'real'`                                          |

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
  message consumers and the override keys (everything when there is none; `only: 'all' | keys`).
  It starts the app unless `start: false` (so pass `port: 0`). Members: `inject(request)` (through
  the plugin named `http`, method defaulting to `GET`), `get`, `close()` (idempotent),
  `[Symbol.asyncDispose]`, `app`, `container`. Default logger: console at `warn`.
- Metadata helpers for hand-written tests: `createMetadata(record)`, `defineTestMetadata(spec)`
  (class-first, tokens `test#Name`), `testToken`, `override(key, value)`, `overrideFactory(key,
  factory, { deps, scope, async, dispose })`.

## 11. CLI (`@znight/cli`)

| Command                       | Behaviour                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `znight new [name]`           | Scaffold a project, interactively or from `--yes`, `--pm <bun\|npm\|pnpm\|yarn>`, `--adapter <node\|fastify\|express\|hono>`, `--features <config,observability,messaging\|all\|none>`, `--no-install`, `--no-git`, `--dir`, `--force`. Bun projects test with `bun test` + preload, others with Vitest |
| `znight generate`             | Write the generated container (compiler `generate`); `--check` (exit 1 when stale, never writes), `-w/--watch` (incremental), `--root`, `--config`, `--config-loader`. Compiler options are read from the `znight()` plugin of the Vite config when it exposes them                                     |
| `znight g <schematic> <name>` | `service`, `controller`, `consumer`, `config`, `guard`, `interceptor` (`--aop` for a method interceptor), `factory`; `--path`, `--flat`, `-f/--force`, `-d/--dry-run`, `--root`. Aliases `generate <schematic>` and `generate:<schematic>`                                                              |
| `znight dev`                  | `vite build --watch` (no Vite dev server) and a full process restart after every successful rebuild — no partial HMR of providers: SIGTERM, `--kill-timeout` then SIGKILL, `--debounce`d and never overlapping restarts; a failed build keeps the last good process; a second Ctrl+C kills (130)        |
| `znight build`                | `vite build` with the Vite config; compiler errors fail the build                                                                                                                                                                                                                                       |
| `znight start`                | Run the build (`--entry`, `--runtime <auto\|node\|bun>`) with `NODE_ENV=production`; on Linux/macOS the CLI `execve`s into the runtime (same PID, signals, exit code), elsewhere it forwards signals and returns the child's code (`128 + n` on signal)                                                 |

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
