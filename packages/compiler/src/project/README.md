# Project model (`src/project/`)

Internal documentation of the foundation layer of `@znight/compiler`. Everything the later phases
(class analysis, binding, validation, codegen, Vite plugin, Bun preload) need to know about the
user's code goes through this layer:

```
scan ─ parse (oxc, cached by content hash) ─ per-file facts ─┐
                                                             ├─ Project (one per process / plugin instance)
module resolution (oxc-resolver) ─ packages ─ manifests ─────┘
       │
       └─ per compile: symbols → identities → types → static evaluation → import routes
```

Spec references: [`docs/internals/architecture.md`](../../../../docs/internals/architecture.md)
§4.1–4.4, §4.6, §6.1, §6.2 (options), §6.4 (source libraries) and §7 (manifests).

## Invariants

- **Paths** are absolute, POSIX-style (`C:/repo/src/a.ts` on Windows) and, for existing files, the
  **real path with the on-disk casing** (`fs.realpathSync.native`). Every map in this layer is
  keyed by such paths. `resolvePath()` / `realPath()` / `toPosixPath()` in `paths.ts` produce them.
- **Offsets** are UTF-16 code units (verified for oxc-parser 0.155: `node.start`/`node.end` index
  the JS string directly, a leading BOM included). Lines and columns are 1-based; columns count
  UTF-16 code units like `tsc` and LSP (`😀` counts as 2). Use `file.location(node)` to get a
  `Location { file, line, column, endLine, endColumn, start, end }`.
- **Determinism**: every list returned is sorted (`compareStrings`, never `localeCompare`);
  identities and type serializations never depend on file system order, symlinks, `node_modules`
  layout or conditions.
- Only **parsing and per-file facts** survive between compiles. Every `refresh()` rebuilds the
  resolution services (`symbols`, `identities`, `types`, `evaluator`, `routes`) and their memo
  tables (§6.1). `SourceFile` instances are reused while their content hash is unchanged, so AST
  nodes can be used as `WeakMap` keys across compiles.
- oxc 0.155 does **not** recover from syntax errors: a file with an error has an empty program.
  Report `project.syntaxErrors()` before any analysis result (there is no `ZNIGHTxxx` code for
  syntax errors yet — see "Gaps").

## Quick start

```ts
import { normalizeOptions } from '../options.ts'
import { Project } from './index.ts'

const project = new Project(normalizeOptions({ root, conditions: ['@znight/source'] }))
project.refresh() // scan + parse; call again on every compile

// scanned files (app + source libraries), sorted
for (const file of project.files()) {
  for (const [, declarations] of file.facts.declarations) {
    const declaration = declarations[0]
    if (declaration.kind !== 'class') continue
    const info = project.identityOf(declaration) // { identity: 'src/users/user.service.ts#UserService', ... }
    const route = project.importRoute(declaration) // { ok: true, route: { specifier: '../users/user.service.js', exportName: 'UserService', ... } }
  }
}
```

Incremental use (Vite watcher):

```ts
project.refresh({ changed: [file] }) // re-read; re-parsed only if the hash changed
project.refresh({ added: [file] }) // re-runs the globs, clears resolution caches
project.refresh({ removed: [file] })
project.refresh({ changed: ['tsconfig.json'] }) // config files (package.json, tsconfig*, lockfiles) clear resolution caches
project.refresh() // full: re-scan, re-read every cached file
```

`RefreshResult` reports `{ files, parsed, reused, rescanned, resolutionCacheCleared, durationMs }`.

## Modules

| File                     | Responsibility                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `../options.ts`          | `ZnightOptions` (§6.2), `normalizeOptions()` → `ResolvedOptions`                     |
| `project.ts`             | `Project`: the facade; owns caches, implements `ProjectHost`                         |
| `host.ts`                | `ProjectHost`: what resolution services need (file access, module resolution)        |
| `paths.ts`, `compare.ts` | path helpers, package-name helpers, deterministic string comparison                  |
| `hash.ts`                | `contentHash()` (SHA-1, `crypto.hash`, Node ≥ 21.7 and Bun)                          |
| `location.ts`            | `Span`, `Position`, `Location`, `LineIndex`                                          |
| `parse.ts`               | `parseSource()` (oxc `parseSync`), language detection                                |
| `facts.ts`               | per-file facts: imports, exports, declarations; `namespaceFacts()`                   |
| `source-file.ts`         | `SourceFile`: text + hash + AST + facts + location helpers                           |
| `file-cache.ts`          | parse cache keyed by path and content hash                                           |
| `scanner.ts`             | `scanDirectory()` (tinyglobby)                                                       |
| `resolver.ts`            | `ModuleResolver` (oxc-resolver): scan/runtime condition sets                         |
| `packages.ts`            | `PackageRegistry`: owner package, root package, public entries, dependencies         |
| `manifest.ts`            | `readManifest()`: `package.json#znight` validation (§7)                              |
| `libraries.ts`           | provider libraries analysed from source (§6.4)                                       |
| `symbols.ts`             | `SymbolResolver`: names → declarations through imports/re-exports/namespaces         |
| `identity.ts`            | `IdentityResolver`: canonical identities (§4.1), public export index, reverse lookup |
| `types.ts`               | `TypeInfo` model, normalizing builders, canonical serialization, substitution        |
| `type-resolver.ts`       | `TypeResolver`: oxc type annotations → `TypeInfo`, generics, heritage                |
| `evaluator.ts`           | `Evaluator`: static evaluation (§4.6)                                                |
| `static-value.ts`        | `StaticValue`, `ValueRef`, `containsRef()`                                           |
| `operators.ts`           | JavaScript operator semantics on primitives (`applyUnary`, `applyBinary`)            |
| `routes.ts`              | `RouteResolver`: import routes (§4.2), `importSpecifier()`                           |
| `diagnostics.ts`         | `Diagnostic` (§6.2 shape), `DiagnosticBag`, ordering                                 |

Everything is re-exported from `index.ts`.

## Options (`../options.ts`)

`normalizeOptions(options, { cwd?, runtimeConditions?, aliases? })` validates (throws `TypeError`
with a `[znight]` message) and fills defaults. Notable resolved fields:

- `root`: real path; `outFile`, `app.entry`, `tsconfig` (when a string): absolute.
- `tsconfig`: `'auto'` (nearest tsconfig of each importing file, default), an absolute path
  (applies to every file) or `false`.
- `scanConditions` = user `conditions` + `['types', 'import', 'node', 'default']`.
  Add `'@znight/source'` (exported as `SOURCE_CONDITION`) to analyse workspace packages from source.
- `runtimeConditions`: from the context (Vite `resolve.conditions`), default `['node', 'import', 'default']`.
- `aliases`: string aliases from the context (Vite `resolve.alias` with string `find` only).
- `externals` must be identities (`'@acme/auth#JwtService'`), bare names are rejected.
- `extensions` are typed `CompilerExtensionLike` (`{ apiVersion, name }`); the full
  `CompilerExtension` interface of §6.5 is structurally assignable to it.

## Files and facts

```ts
const file = project.getFile('src/users/user.service.ts') // relative to root, or absolute
file.path
file.text
file.hash
file.language
file.isDeclarationFile
file.program
file.parseErrors

file.facts.imports.get('Logger')
// { local: 'Logger', kind: 'named' | 'default' | 'namespace' | 'require', imported: 'Logger',
//   specifier: '@acme/lib', typeOnly: false, span, specifierSpan }
file.facts.exports.get('default')
// { kind: 'local', local: 'Service' } | { kind: 'expression', expression }
// | { kind: 'reexport', imported, specifier } | { kind: 'namespace', specifier }   (export * as ns)
file.facts.starExports // export * from '...'
file.facts.declarations.get('UserService')
// Declaration[] (several when merged: overloads, interface + class, namespace + class...)
// { file, name, localName, kind, node, span, ambient, anonymous, destructured, namespace }
file.facts.exportAssignment // `export = x`
file.facts.moduleRequests // every specifier, for watching / casing checks
namespaceFacts(declaration) // members of `namespace NS {}` / `declare namespace NS {}`
```

Declaration kinds: `class | interface | type | enum | function | const | let | var | namespace`.
`declaration.node` is the AST node (`VariableDeclarator` for variables). Anonymous default
exports (`export default class {}`) are declared under the name `default` with
`anonymous: true`. Namespace members have dotted names (`Models.Inner`) and a `namespace` link.
In ambient namespaces without explicit `export`, every member is exported (TypeScript rule).

## Module resolution

```ts
project.resolveModule(fromFile, './user.repository.js') // scan mode (default)
project.resolveModule(fromFile, '@acme/lib', undefined, 'runtime')
// { kind: 'file', path, requestedPath, casingMismatch } | { kind: 'builtin', specifier: 'node:fs' } | { kind: 'not-found', message }
```

- **scan** mode: TypeScript first (`.js` → `.ts/.tsx/.d.ts/.js`, `.mjs` → `.mts/.d.mts/.mjs`,
  `.cjs` → `.cts/.d.cts/.cjs`), `types`/`typings` fields, scan conditions. A bare specifier that
  resolves to JavaScript is retried with TypeScript's declaration lookup (`@types/*`).
- **runtime** mode: runtime conditions, spec `extensionAlias`, `module`/`main` fields.
- Pass the specifier `span` to get casing diagnostics (ZNIGHT010 warning) for scanned importers.
- `resolver.clearCache()` is called by `refresh()` on create/unlink and config changes.

## Symbols

`project.symbols` (or the facade methods) resolves a name used in a file:

```ts
project.resolveIdentifier(file, 'UserService') // local, imported, re-exported...
project.resolveIdentifier(file, 'pg.Pool') // default-import member → pg's `Pool` export
project.resolveIdentifier(file, decorator.expression.callee) // Identifier / MemberExpression / TSQualifiedName
project.resolveIdentifier(file, 'Settings', 'type') // meaning: 'value' | 'type' | 'any' (merged declarations)
project.resolveExport('src/users/index.ts', 'UserService')
project.exportNames('src/users/index.ts') // includes names from `export *`
project.symbols.resolveInScope({ file, namespace }, name) // inside a namespace body
```

`SymbolResolution` is one of:

| kind          | meaning                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `declaration` | `declaration` (picked for the meaning) + all merged `declarations`                                                    |
| `module`      | a namespace object (`import * as ns`, `export * as ns`)                                                               |
| `expression`  | `export default <expression>`                                                                                         |
| `external`    | builtin (`node:events`) or untyped/CommonJS package export: `specifier` + `path`                                      |
| `global`      | not declared nor imported (`Promise`, `Date`, or a typo)                                                              |
| `unresolved`  | `reason` (`module-not-found`, `export-not-found`, `ambiguous-export`, `circular`, `not-a-namespace`, ...) + `message` |

`export *` follows TypeScript: local exports win, `default` is never re-exported, a name found
through two different `export *` is `ambiguous-export`; cycles terminate.

## Identities (§4.1)

```ts
project.identityOf(symbolOrDeclaration)
// { identity, displayName, owner: 'application' | 'package' | 'external' | 'global',
//   specifier, exportPath, public, relativePath }
project.lookupIdentity('@acme/lib#tokens.Holder') // reverse: identity → SymbolResolution
```

| entity                                     | identity                                          |
| ------------------------------------------ | ------------------------------------------------- |
| application declaration                    | `src/users/user.service.ts#UserService`           |
| application namespace member               | `src/ns.ts#Models.Inner`                          |
| application anonymous / expression default | `src/x.ts#default`                                |
| package export (root entry)                | `@acme/lib#Logger`                                |
| package export only from a subpath entry   | `@acme/lib/testing#FakeLogger`                    |
| member of an exported namespace            | `@acme/lib#tokens.Holder`                         |
| namespace object exported by a package     | `@acme/lib#tokens` (`export * as tokens`)         |
| DefinitelyTyped declaration                | `pg#Pool` (from `@types/pg`)                      |
| package-internal (not public)              | `@acme/lib/src/internal.ts#Base`, `public: false` |
| builtin / untyped CommonJS export          | `node:events#EventEmitter`, `cjs-pkg#Thing`       |
| global                                     | `globalThis#Date`                                 |

Package identities are computed by the **public export index** of the package
(`project.identities.publicIndex(pkg)`): every public entry (root, then `exports` subpaths in
sorted order; patterns are not enumerable) is resolved with the scan conditions and walked through
re-exports, `export *`, namespaces and tsdown's `declare namespace x_exports { export { ... } }`.
Preference: root entry, shorter path, named before `default`, then lexicographic. The result is the
same for `src/*.ts` and for tsdown's `dist/*.d.mts` chunks with renamed declarations
(`Client$1 as V1Client`) — see `test/project/golden.test.ts`.

## Types (§4.4)

```ts
const type = project.resolveType(file, param.typeAnnotation, project.typeScopeOf(classDeclaration))
serializeType(type) // normative string, e.g. 'src/repo.ts#Repository<src/user.ts#User, string>'
formatType(type) // for messages: 'Repository<User, string>'
```

`TypeInfo` kinds: `primitive`, `literal`, `reference { identity, name, typeArgs }`, `array`,
`tuple`, `union`, `intersection`, `promise`, `opaque { text, reason }` and `typeParameter { name }`.
Builders normalize: `Array<T>`/`ReadonlyArray<T>`/`readonly T[]` → `T[]`; unions/intersections
flattened, de-duplicated, sorted, `true | false` → `boolean`, literals absorbed by their primitive,
`never` dropped, `any`/`unknown` absorbing; default type arguments filled; aliases expanded with
substitution; recursive aliases opaque as a whole. Opaque reasons tell ZNIGHT010 messages why
(`function`, `object-literal`, `typeof`, `import-type`, `mapped`, `conditional`, `unresolved`,
`missing-annotation`, ...). Unresolvable imports give `opaque` with reason `unresolved`; unknown
names give a `globalThis#Name` reference.

Generics and inheritance (for inherited constructors, §4.5):

```ts
const heritage = project.heritageOf(classDeclaration)
// [{ relation: 'extends' | 'implements', symbol, type, span }], own type parameters left unbound
const base = heritage[0].type // 'src/base.ts#Repository<T[]>'
const bindings = project.bindTypeArguments(classDeclaration, typeArgs) // fills defaults
substituteType(base, bindings) // 'src/base.ts#Repository<User[]>'
project.typeParametersOf(declaration) // [{ name, constraint, default }]
withTypeParameters(scope, method.value.typeParameters) // add method type parameters
```

`extends Mixin(Base)` gives `symbol.kind === 'unresolved'` (`unsupported-expression`) and an opaque
type: report ZNIGHT010 "declare an explicit constructor".

## Static evaluation (§4.6)

```ts
const result = project.evaluate(file, decoratorArgument) // refs: 'top' (default)
project.evaluate(file, staticArgument, { refs: 'none' }) // must be a value
project.evaluate(file, optionsArgument, { refs: 'nested' }) // ValueRef inside objects/arrays
// { kind: 'value', value, files } | { kind: 'ref', ref: ValueRef, files } | { kind: 'error', error: { message, location, hint }, files }
```

Grammar: literals, `undefined`/`NaN`/`Infinity`, unary `- + ! ~ void`, arithmetic, bitwise and
shifts, comparisons, string concatenation, `?? || &&` (short-circuit), `a ? b : c`, template
literals, member/element access (and optional chaining) on evaluated objects/arrays/strings, array
and object literals with spreads and computed keys, `as`, `as const`, `satisfies`, `<T>x`, `x!`,
parentheses, `const` and `enum` references across files and packages (cycle-guarded, memoized per
compile). In declaration files, `declare const X: <literal type>` (what tsdown emits for `as const`
values) is evaluated from its type. Values are frozen; bigints are kept as bigints.

A reference to a binding that is not evaluable (class, function, `let`, `const x = call()`,
builtin/untyped export) becomes a `ValueRef { identity, name, text, symbol, location }`; pass
`ref.symbol` to `project.importRoute()`. Errors carry the hint "Extract the value to
`export const X = ...`" where relevant. `files` lists every file read (for invalidation).

## Import routes (§4.2)

```ts
project.importRoute(declarationOrSymbolOrIdentity, (fromFile = options.outFile))
// { ok: true, route: { specifier, exportName, members, typeOnly } }
// { ok: false, error: { reason, message, hints } }   // reason: not-exported | anonymous-default | internal | global | unresolved | runtime-unresolvable
importSpecifier(fromFile, targetFile, 'js' | 'ts' | 'none')
```

- Application declarations are imported from their **declaring module** (alias-aware:
  `export { Internal as Public }` → `Public`; `export = X` → `default`), never through barrels.
- Package declarations use the public entry specifier and export name, after checking that the
  specifier resolves with the **runtime** conditions from `fromFile`.
- `members` reaches namespace members (`import { tokens } from '@acme/lib'` → `tokens.Holder`).
- CommonJS (`export =` package entries, untyped packages): `exportName: 'default'` and the export
  path in `members` (`import legacy from 'legacy-ns'` → `legacy.Client`).
- `typeOnly` is set for interfaces, type aliases and declaration-file-only entities.
- Failures map to ZNIGHT005 with the fix-it in `hints` ("Export it: `export class X ...`").

## Packages and manifests (§7)

```ts
project.rootPackage // nearest named package.json of the root
project.packageOf(path) // nearest *named* package.json (dist/package.json {type} skipped)
project.ownerOf(path) // { kind: 'application' | 'package', package }
project.packages.entries(pkg) // public entries [{ subpath: '.', specifier: '@acme/lib' }, ...]
project.manifestOf(pkg) // validated PackageManifest | undefined
project.libraries() // provider libraries scanned from source
project.diagnostics() // ZNIGHT018 manifest problems, ZNIGHT010 casing/library warnings
```

`PackageManifest` = `{ packageName, packageDir, apiVersion, compiler: string[], provides:
{ export, identity, plugin, scope, optional }[], interceptors: { decorator, decoratorIdentity,
interceptor, interceptorIdentity }[], library: 'source' | undefined, providers: absolute path }`.
Manifests of all root dependencies are read during the scan; problems are ZNIGHT018 (an
unsupported `apiVersion` is an error and the manifest is ignored, a missing one is a warning).

Source libraries (§6.4): packages listed in `libraries` and root dependencies whose manifest says
`"library": "source"`, scanned when one of their public entries resolves to a `.ts` source with the
scan conditions. Their files use the application `include`/`exclude` globs relative to the package
directory, plus the entry files. They keep package identities and package routes.

## Writing the next phases

- **Class analysis**: iterate `project.files()`, `file.facts.declarations` (kind `class`), read
  decorators from `declaration.node.decorators`, resolve each decorator callee with
  `project.resolveIdentifier(file, callee)` and compare `identity` with the extension's decorator
  identities. Constructor parameter types: `project.resolveType({ file, namespace: declaration.namespace }, annotation, project.typeScopeOf(declaration))`.
  Decorator arguments: `project.evaluate(...)` (static → `refs: 'none'`; value → default/nested).
- **Inherited constructors**: walk `project.heritageOf()`; the `extends` clause symbol gives the
  base declaration; substitute with `bindTypeArguments` + `substituteType`.
- **Binding**: compare `serializeType()` strings; `ReferenceType.identity` is the provider type
  identity; `externals` and manifest `provides` already are identities.
- **Codegen**: `project.importRoute(target)` for every value/type the generated module imports;
  `ValueRef.symbol` for decorator argument references.
- **Vite plugin**: one `Project` per plugin instance; `refresh({ changed/added/removed })` from the
  watcher; watch `file.facts.moduleRequests` targets and evaluation `files`.
- **Diagnostics**: `Diagnostic` in `diagnostics.ts` is the §6.2 shape (`location` is a superset with
  `start`/`end` for code frames). Collect with `DiagnosticBag` for de-duplication and ordering.

## Tests and fixtures

`test/project/*.test.ts` (bun:test). The main fixture is `test/fixtures/app`, a small application
with hand-written fake packages in `node_modules` (committed: see `test/fixtures/.gitignore`;
Biome is disabled for fixtures by `test/fixtures/biome.json`):

- `@fixture/lib`: sources **and** the real tsdown 0.23 output (`dist/*.d.mts` chunks, renamed
  declarations, `declare namespace` for `export * as`), used by the golden test;
- `@fixture/manifest-lib` (source library through its manifest), `@fixture/bad-manifest`
  (`apiVersion: 2`), `pg` + `@types/pg`, `cjs-only` (untyped CommonJS), `legacy-ns` (`export =`).

`test/project/helpers.ts` provides `appProject()`, `fileOf()`, `declarationOf()`, `aliasBody()`,
`initializerOf()` and `tempDir()` for throw-away projects.

## Gaps and decisions to revisit

- No error code exists for syntax errors (oxc returns an empty program); `syntaxErrors()` exposes
  them. Proposal: add one to `ErrorCode` (spec §4.8).
- Ambient module declarations (`declare module 'x' {}`, e.g. `@types/node`) are not indexed:
  builtins resolve to `external` symbols (`node:events#EventEmitter`) without declarations.
- `exports` patterns (`"./features/*"`) are not enumerated as public entries.
- Constants widened by the declaration emit (`export const PREFIX: string` in `.d.ts`) are not
  evaluable from `dist`; library authors should use literal types / `as const` for values used in
  static decorator arguments.
- Dotted namespace declarations (`namespace A.B {}`) and `import x = NS.y` aliases are ignored.
