# @znight/compiler

The compile-time half of [Znight](../../README.md). The compiler reads your TypeScript sources with
[oxc](https://oxc.rs), recognises the Znight decorators, resolves every injection point to a
concrete provider, validates the whole graph and produces the dependency-injection plan that
`@znight/core` executes at runtime. No `reflect-metadata`, no `emitDecoratorMetadata`, no runtime
type lookup: a misconfiguration is a build error with a precise location and a fix-it.

```sh
bun add -d @znight/compiler
```

> **Status (0.1 preview).** This package currently ships the **analysis, binding and validation**
> phases and the public **compiler extension API**. The Vite plugin, `compile()` / `generate()` and
> the code generator (`src/.znight/container.generated.ts`) are being built on top of the
> `ApplicationGraph` produced here.

## Quick start

```ts
import { analyze, normalizeOptions, Project } from '@znight/compiler'

const project = new Project(normalizeOptions({ root: process.cwd() }))
project.refresh() // scan + parse (cached by content hash; call again after changes)

const { graph, diagnostics } = await analyze(project)
for (const diagnostic of diagnostics) {
  console.log(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`)
}
console.log(graph.resolutionOrder) // providers, dependencies first
```

`analyze()` loads the compiler extensions of the Znight packages you use (`@znight/http`...),
analyses every decorated class, binds every injection point and runs every validation.
`analyzeProject(project, loadedExtensions)` is the synchronous variant for watchers that load the
extensions once with `loadExtensions(project)`.

## How dependencies are resolved

Every provider has a **token**: the canonical identity of its declaration
(`src/users/user.service.ts#UserService`, `@acme/auth#JwtService`,
`src/db/db.factory.ts#DbFactory.createPool` for a `@Provides` method). Messages always show display
names (`UserService`, `Repository<User>`) with `file:line`.

For a constructor (or `@Provides` method) parameter of type `T`:

| Rule                                                                                            | Result                                    |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Candidates: providers whose provided type **is** `T` (exact) or that **extend / implement** `T` | interfaces and abstract classes just work |
| `@Inject('name')` keeps the candidates named `name` (`@Named('name')`, `{ name }` options)      | qualifiers                                |
| `T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>` with `T` a class/interface                | every candidate, ordered by token         |
| A single exact candidate, else the single `@Primary()`, else the single candidate               | bound                                     |
| Several candidates providing the exact same type / different types                              | ZNIGHT004 / ZNIGHT008                     |
| No candidate, type declared in a package manifest `provides` or in the `externals` option       | external (supplied by a plugin)           |
| No candidate, optional parameter (`?`, `\| undefined`, `\| null`, default value, `@Optional()`) | `undefined` is injected                   |
| No candidate otherwise                                                                          | ZNIGHT001 with a near-miss analysis       |
| `Lazy<T>` (from `@znight/core`)                                                                 | same rules, resolved at call time         |
| Primitive or anonymous types (`string`, `{ port: number }`...) need `@Inject('name')`           | matched by name and kind                  |

Generic types are compared with their type arguments (`Repository<User>` ≠ `Repository<Order>`),
type aliases are expanded and default type arguments filled in. Constructors are inherited:
`class UserRepository extends BaseRepository<User> {}` is injected through `BaseRepository`'s
constructor with `T = User`.

```ts
@Injectable()
export class UserService {
  constructor(
    private readonly users: Repository<User>, // the class implementing Repository<User>
    @Inject('fake') private readonly clock: Clock, // the Clock named 'fake'
    private readonly plugins: Plugin[], // every Plugin provider
    private readonly audit: Lazy<AuditService>, // breaks a cycle
    private readonly logger: Logger, // provided at runtime by ObservabilityPlugin
    private readonly cache?: Cache, // optional
  ) {}
}
```

Aliases are recorded for every interface / base class / provided type bound to a single provider
(or a single `@Primary`), so `container.get(UserRepository)` works at runtime.

## Decorators

Decorators are recognised by the canonical identity of their callee: renamed imports
(`import { Injectable as Service }`), barrels, `export *` and namespace imports (`@zn.Injectable()`)
all work. A local function wrapping a Znight decorator (`const Service = () => Injectable()`) is
invisible to the compiler and reported as a ZNIGHT005 warning.

| Decorator (`@znight/core`)                         | Analysis                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@Injectable({ scope?, name?, primary? })`         | class provider; options must be statically evaluable                                             |
| `@Factory()`                                       | singleton provider whose `@Provides` methods are providers                                       |
| `@Provides({ scope?, name?, primary?, dispose? })` | the explicit return type is the provided type; `Promise<T>` → async (singletons only, ZNIGHT014) |
| `@Inject(name)` / `@Optional()`                    | constructor and `@Provides` parameters                                                           |
| `@Named(name)` / `@Primary()`                      | class or `@Provides` method                                                                      |
| `@Intercept(Interceptor, options?)`                | interceptor chain of a method (top-most decorator = outermost)                                   |

Interceptor classes referenced by `@Intercept` (and guards referenced by extensions) need no
decorator: a class that is not a provider is registered as a singleton automatically. Packages can
declare interceptor decorators in their manifest (`@Logged()` → `LoggedInterceptor`).

Decorator arguments follow §4.6 of the spec: _static_ arguments (names, scopes, paths) must be
statically evaluable (literals, `const` references across files and packages, simple expressions);
_value_ arguments (options, schemas, guards) are evaluated when possible and otherwise must be
references to exported bindings, which the generated module imports.

## Diagnostics

| Code      | Reported when                                                                                                                                                                                          | Severity        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| ZNIGHT001 | a required dependency has no provider (with hints: wrong import, missing `@Injectable`, excluded file, missing `implements`, other type arguments, qualifier)                                          | error           |
| ZNIGHT002 | circular dependency (constructor, multi, optional, interceptor and factory edges); the cycle is printed                                                                                                | error           |
| ZNIGHT003 | a singleton depends on a request-scoped provider or external, directly or through transients, multi, interceptors or extension edges                                                                   | error           |
| ZNIGHT004 | several providers of the exact same type                                                                                                                                                               | error           |
| ZNIGHT005 | invalid decorator usage (target, arguments, unexported reference, abstract/generic/unexported provider, several provider decorators, `@Provides` misuse, ineffective decorators, composite decorators) | error / warning |
| ZNIGHT008 | several candidates for an interface or base type                                                                                                                                                       | error           |
| ZNIGHT009 | lifecycle hook that is static or has required parameters (error), never called (warning)                                                                                                               | error / warning |
| ZNIGHT010 | injection type that cannot be analysed (missing annotation, primitive without qualifier, unresolvable import, inherited constructor of `Mixin(Base)`)                                                  | error           |
| ZNIGHT014 | async factory on a non-singleton                                                                                                                                                                       | error           |
| ZNIGHT018 | compiler extension problems (untrusted, `apiVersion`, duplicate names, load failures) and manifest problems                                                                                            | error / warning |
| ZNIGHT019 | provider unreachable from any root (with `reportUnused`)                                                                                                                                               | warning         |
| ZNIGHT020 | a provider module imports (transitively) the generated module: ESM cycle                                                                                                                               | error           |

```
error ZNIGHT001 src/consumer.ts:13:21: Missing provider for 'EmailService' required by Consumer
  = hint: Another 'EmailService' (a provider) is declared in src/mail/email.service.ts:4, but this injection refers to the one in src/legacy/email.service.ts:1: check the import
  = hint: EmailService (src/legacy/email.service.ts:1) is not a provider: add @Injectable()
```

**Unused providers** (`reportUnused`, `prune`). Roots are: providers registered by compiler
extensions (controllers, consumers, config classes...), providers with an `onStart` / `onReady` /
`onStop` hook, and providers referenced as a value in your code outside of decorators and types
(`app.container.get(UserService)`, `overrides` entries — referencing an abstract class or interface
counts for its aliased provider). Everything reachable from a root is used.

## Options

`normalizeOptions(options)` validates and fills the defaults. Options used by the analysis:

| Option              | Default                                                | Description                                                                          |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `root`              | `process.cwd()`                                        | project root                                                                         |
| `include`           | `['src/**/*.{ts,tsx,mts}']`                            | sources to analyse                                                                   |
| `exclude`           | `['**/*.{test,spec}.*', '**/*.d.ts', '**/.znight/**']` | excluded sources                                                                     |
| `outFile`           | `'src/.znight/container.generated.ts'`                 | generated module (ZNIGHT020 checks imports of it)                                    |
| `tsconfig`          | nearest tsconfig of each file                          | `paths` resolution; a path, or `false`                                               |
| `conditions`        | `[]`                                                   | extra scan conditions (`'@znight/source'` to analyse workspace packages from source) |
| `extensions`        | `[]`                                                   | additional compiler extensions (win over discovered ones with the same name)         |
| `trustedExtensions` | `[]`                                                   | third-party packages allowed to load a compiler extension                            |
| `externals`         | `[]`                                                   | identities provided at runtime by your own plugins (`'@acme/auth#JwtService'`)       |
| `libraries`         | `[]`                                                   | packages analysed from source (provider libraries)                                   |
| `reportUnused`      | `false`                                                | ZNIGHT019 warnings                                                                   |
| `prune`             | `false`                                                | compute reachability to drop unused providers                                        |

`importExtension`, `sourceLocations`, `stripDecorators`, `library`, `strictValidation` and `app`
are used by the code generator and the Vite plugin.

## Package manifests

Packages describe what they bring in `package.json#znight` (spec §7):

```jsonc
"znight": {
  "apiVersion": 1,
  "compiler": "@znight/http/compiler",                       // module default-exporting a CompilerExtension (or an array)
  "provides": [{ "export": "HttpContext", "plugin": "HttpPlugin", "scope": "request" }],
  "interceptors": [{ "decorator": "Logged", "interceptor": "LoggedInterceptor" }]
}
```

Compiler extensions are discovered in the manifests of the packages imported by the analysed code
and resolved with the runtime conditions (plus `@znight/source` under Bun). `@znight/*` packages are
trusted; other packages must be listed in `trustedExtensions` (otherwise a ZNIGHT018 warning and the
extension is not loaded).

## Writing a compiler extension

A feature package exposes `@acme/feature/compiler`, which **only `import type`s** from
`@znight/compiler` (building or running the package never loads the compiler):

```ts
import type { CompilerExtension } from '@znight/compiler'

interface Route {
  token: string
  path: string
  handler: string
}

export default {
  apiVersion: 1,
  name: 'acme-http',
  decorators: {
    '@acme/http#Controller': { targets: ['class'], params: ['static'] },
    '@acme/http#Get': { targets: ['method'], params: ['static'] },
    '@acme/http#UseGuard': { targets: ['class', 'method'], params: [], rest: 'value' },
  },
  analyzeClass(cls, ctx) {
    const controller = cls.decorators.find(d => d.identity === '@acme/http#Controller')
    if (!controller) return
    const token = ctx.registerProvider(cls) // ZNIGHT005 if another decorator registered it
    for (const guard of cls.decorators.filter(d => d.identity === '@acme/http#UseGuard').flatMap(d => d.args)) {
      ctx.resolveClassRef(guard, { from: cls, role: 'guard' }) // auto-registers helper classes
    }
    for (const method of cls.methods) {
      const get = method.decorators.find(d => d.identity === '@acme/http#Get')
      if (get) ctx.store({ token, path: String(get.args[0]?.value ?? '/'), handler: method.name })
    }
  },
  validate(ctx) {
    // ctx.graph, ctx.stored, ctx.provider(token), ctx.binding(handle), ctx.report(...)
  },
  generate(ctx) {
    return ctx.obj({ routes: ctx.arr(ctx.stored.map(route => ctx.obj({ path: route.path, handler: route.handler }))) })
  },
} satisfies CompilerExtension<Route>
```

| API                                                            | Purpose                                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decorators: Record<identity, { targets, params, rest? }>`     | owned decorators; targets and arguments are validated, arguments evaluated (`static` / `value`)                                                                                                      |
| `analyzeClass(cls, ctx)`                                       | called for every class carrying one of the extension's decorators, in identity order                                                                                                                 |
| `ClassInfo`                                                    | identity, import route, decorators (`ArgInfo { value, ref, location, text }`), constructor (inherited, substituted), methods, properties, heritage closure, lifecycle                                |
| `ctx.registerProvider(cls, { scope, name, primary, factory })` | registers a provider; `factory` = custom factory with injected `deps` and a `generate` callback                                                                                                      |
| `ctx.resolveClassRef(arg, { from, role })`                     | binds a class reference to a token (auto-registers helper classes)                                                                                                                                   |
| `ctx.bindInjection(request, { from })`                         | binds a type with the §4.7 rules; read the result with `binding(handle)`                                                                                                                             |
| `ctx.addDependency(from, to)`                                  | runtime dependency resolved by the plugin (ZNIGHT003, ZNIGHT019)                                                                                                                                     |
| `ctx.report(diagnostic)`, `ctx.store(data)`                    | diagnostics; data for `validate` / `generate`                                                                                                                                                        |
| `ctx.types`, `ctx.project`                                     | type helpers (`format`, `serialize`, `equals`...), project model (evaluation, resolution)                                                                                                            |
| `validate(ctx)`                                                | after binding: the full `ApplicationGraph`                                                                                                                                                           |
| `generate(ctx)`                                                | returns a `GenNode` built with `obj`, `arr`, `lit`, `ref`, `member`, `call`, `construct`, `arrow`, `code\`\``, `importValue`, `importType`, `importFrom`, `tokenOf` — raw strings are never accepted |

An extension that throws is reported as ZNIGHT018 naming it; the compile goes on.

## Compiler contract

The generated module calls **no helper of `@znight/compiler`**: it imports `@znight/core` (types),
the application's providers and the helpers exported by feature packages. The stable contracts of
this package are:

- the **compiler extension API**, version `EXTENSION_API_VERSION = 1` (`CompilerExtension`,
  `DecoratorSpec`, `ClassInfo`, `ArgInfo`, `AnalyzeContext`, `ValidateContext`, `GenerateContext`,
  `GenNode`), exported as types from the root entry;
- the **package manifest** (`package.json#znight`, `apiVersion: 1`);
- the **`ApplicationGraph`** consumed by the code generator (internal, documented in
  [`src/graph/README.md`](./src/graph/README.md)).

## Limitations

- Classes declared inside namespaces, class expressions and nested classes are not analysed.
- Interceptors are collected from the class and its base classes; an overriding method without
  decorators removes the interceptors of the base method.
- Unused-provider roots do not see string lookups (`container.get('UserService')`).
- Compiled provider libraries (`znight.providers.json`) are not merged yet.

## License

MIT
