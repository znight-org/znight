# Application graph (`src/graph/`)

Internal documentation of the intermediate representation produced by the analysis phases and
consumed by the code generator (`src/codegen/`), library mode (`src/library/`) and by extension
`validate` hooks.

```
Project (src/project) ─ analyze() ─┬─ class analysis (src/analysis): ClassInfo, decorators, core + extensions
                                   ├─ compiled provider libraries (src/library/merge.ts, §6.4)
                                   ├─ binding (src/binding): §4.7, near-miss analysis
                                   ├─ graph assembly (src/graph/build.ts): deps, edges, aliases, order
                                   └─ validation (src/validation): ZNIGHT002/003/009/019/020 + extension validate
                                        ↓
                               ApplicationGraph  →  codegen (literal emitter, import routes, GenerateContext)
```

Exact types: [`types.ts`](./types.ts). Spec: [`docs/internals/architecture.md`](../../../../docs/internals/architecture.md)
§3.2 (metadata), §3.3 (generated module), §4.7 (binding), §6.5 (extensions).

## Entry point

```ts
import { analyze, normalizeOptions, Project } from '@znight/compiler'

const project = new Project(normalizeOptions(options, { runtimeConditions }))
project.refresh() // or refresh({ changed, added, removed }) from a watcher
const { graph, diagnostics, classes, extensions, stats } = await analyze(project)
```

- `analyze()` loads the compiler extensions (`loadExtensions`) then runs `analyzeProject()`, which is
  synchronous. A watcher can load extensions once and call `analyzeProject(project, loaded)` on
  every change (only parsing/facts are cached by the project, everything else is recomputed, §6.1).
- `graph.diagnostics` (= `diagnostics`) contains every phase's diagnostics, sorted, including the
  project layer's (`project.diagnostics()`: manifests, casing). **Syntax errors are not included**:
  report `project.syntaxErrors()` first (a file with a syntax error has an empty program).
- Do not generate code when there is an error: the graph stays well-formed (failed bindings become
  placeholder dependencies, see below) but is not meaningful.
- `result.extensions` are the loaded extensions (`extension.generate` is called by codegen, in this
  order).

## Determinism

Every list is sorted with `compareStrings` (never `localeCompare`): providers and externals by
token, aliases by key, edges by `(from, to, kind, label)`, interceptor chains by method name,
`resolutionOrder` topologically with ties broken by token. Extension data is stored in call order,
and `analyzeClass` is called in class identity order, so it is deterministic too. Shuffling the
scan order gives a byte-identical graph (`test/analysis/determinism.test.ts`).

## `ApplicationGraph`

| Field             | Content                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`       | `ProviderNode[]`, sorted by token                                                                                                                     |
| `externals`       | `ExternalNode[]` referenced by at least one binding / interceptor / extension edge                                                                    |
| `aliases`         | `AliasNode[]` (`{ key, token }`), sorted by key → `metadata.aliases`                                                                                  |
| `resolutionOrder` | every provider token, dependencies first → `metadata.resolutionOrder`                                                                                 |
| `edges`           | every dependency edge (validation, prune), typed by `EdgeKind`                                                                                        |
| `extensions`      | `{ name, stored }[]`: data each extension stored with `ctx.store()`, in extension order                                                               |
| `bindings`        | results of `AnalyzeContext.bindInjection` by handle id (`undefined` when it failed)                                                                   |
| `bindingRequests` | the requests of `AnalyzeContext.bindInjection` by handle id (library mode)                                                                            |
| `roots`           | roots declared by extensions (`addRoot`) and compiled libraries: `{ token, origin, reason, location }`, sorted by token then origin (always computed) |
| `reachability`    | `{ roots, unreachable }` when `reportUnused` or `prune` is set, else `undefined`                                                                      |
| `diagnostics`     | sorted diagnostics of every phase                                                                                                                     |

### `ProviderNode` → `ProviderDefinition` (§3.2)

| `ProviderNode` | Emitted as                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `token`        | the computed key `['<token>']` of `metadata.providers`                                                                                     |
| `scope`        | `scope`                                                                                                                                    |
| `importRoute`  | `class` for `kind: 'class' \| 'custom'` (import the class with this route). Omit `class` for `provides` (the route is the factory class's) |
| `deps[i].ref`  | `deps[i]` (already a `DependencyRef`: `Token`, `{ token, optional: true }`, `{ multi }`, `{ lazy }`)                                       |
| `factory`      | see below                                                                                                                                  |
| `async`        | `async: true` when set                                                                                                                     |
| `interceptors` | `interceptors[method] = { async, chain: [{ dep, options? }] }` (omit `options` when `hasOptions` is false)                                 |
| `dispose`      | `dispose` when set                                                                                                                         |
| `name`         | `name` when set                                                                                                                            |
| `primary`      | `primary: true` when set                                                                                                                   |
| `source`       | `source` (already relative to the root), per `sourceLocations`                                                                             |

`displayName`, `kind`, `registeredBy`, `classIdentity`, `method`, `providedType`, `heritage`,
`lifecycle` and `location` are for messages, validation, library mode and tooling.
`DependencyNode.request` (parameters only) is the injection point before binding (type, qualifier,
optional): library mode records it so that applications bind it again.

#### Factories

`deps` is ordered so that factories use contiguous indexes:

| `factory.kind` | Generated factory                                                            | `deps` layout                                                                           |
| -------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `constructor`  | `d => new Class(d[0], …, d[args-1])` (`() => new Class()` when `args === 0`) | `args` parameters, then interceptors                                                    |
| `method`       | `d => d[0].method(d[1], …, d[args])`                                         | `[0]` the `@Factory` instance (`role: 'factory'`), `args` parameters, then interceptors |
| `custom`       | `d => <factory.generate(ctx, { cls, deps: [d[0]…d[args-1]] })>`              | `args` custom dependencies, then interceptors                                           |
- Interceptor dependencies always come **after** the factory arguments (`role: 'interceptor'`),
  one per distinct interceptor token, so the factory never receives them.
- A parameter whose binding failed is `{ token: <serialized type>, optional: true }` (an error was
  reported; the graph stays well-formed).
- Optional parameters bound to nothing are `{ token, optional: true }`: the runtime injects
  `undefined`, which triggers JavaScript default parameter values. The token is never a provider
  token nor an alias key: the type identity for an unqualified, public, non-generic type, the
  qualifier for a qualified injection, otherwise the display of the type (`Repository<User>`).
- `factory.generate` (custom) is the extension's `CustomFactory.generate`: call it with the
  extension's `GenerateContext` and splice the returned `GenNode` as the factory body.

#### Interceptors

`interceptors` is sorted by method name; each chain is in decorator source order (top-most first =
outermost, §8.4). `link.dep` indexes `deps`; `link.options` is a `StaticValue` that may be (or
contain) `ValueRef`s — emit it with the literal emitter, importing each `ValueRef` through
`project.importRoute(ref.symbol)` (refs were already checked to be importable).

### Externals

`ExternalNode` → `metadata.externals[]`: `{ token, scope?, providedBy?, optional? }` (omit `scope`
when singleton, `optional` when false). `origin` is `'manifest'` (package `provides`) or `'option'`
(`options.externals`).

### Aliases

Every provided-type / heritage identity bound to exactly one provider (or one `@Primary`), except
provider tokens, `globalThis#*`, the core marker types (`Lazy`, `OnStart`, `OnReady`, `OnStop`,
`MethodInterceptor`), externals (manifest `provides`, `options.externals`, `CoreTokens`: the
container resolves registrations through aliases, so plugins would overwrite the application
provider) and package-internal identities (layout-dependent, not nameable by user code).

### Edges (`GraphEdge`)

| Kind          | Meaning                                                                                                  | Order | 002 | 003 | 019 |
| ------------- | -------------------------------------------------------------------------------------------------------- | :---: | :-: | :-: | :-: |
| `dependency`  | required parameter / custom dependency                                                                   |   ✓   |  ✓  |  ✓  |  ✓  |
| `optional`    | optional parameter bound to a provider                                                                   |   ✓   |  ✓  |  ✓  |  ✓  |
| `multi`       | one edge per element of a multi injection                                                                |   ✓   |  ✓  |  ✓  |  ✓  |
| `lazy`        | `Lazy<T>` (escape hatch)                                                                                 |       |     |     |  ✓  |
| `interceptor` | provider → interceptor                                                                                   |   ✓   |  ✓  |  ✓  |  ✓  |
| `factory`     | `@Provides` provider → its `@Factory`                                                                    |   ✓   |  ✓  |  ✓  |  ✓  |
| `extension`   | `addDependency`, `resolveClassRef({ from })`, `bindInjection({ from })` (resolved by plugins at runtime) |       |     |  ✓  |  ✓  |

Edges to externals are kept (`to` is the external token); `resolutionOrder` and ZNIGHT002 only
follow edges between providers.

### Compiled provider libraries (§6.4)

`analyzeProject()` merges the `znight.providers.json` fragments of the root dependencies (manifest
`"providers"`, source libraries excluded) after the extensions' `analyzeClass` and before binding
(`src/library/merge.ts`): each fragment provider becomes a `ProviderDraft` whose `cls` is the
`ClassInfo` of the package's declaration (`dist/*.d.mts`: import route, heritage), whose params,
qualifiers, scope, interceptors and lifecycle come from the fragment. Interceptor drafts only need
`method: { name, async }` and `decorator: { identity, name, location }` (the registry types were
narrowed to these fields for that purpose). Extension data is appended to the extension's stored data
(after the application's, by package name) and `bindInjection` requests are re-bound with new ids.

## `prune`

With `prune`, drop `graph.reachability.unreachable` providers from `metadata.providers` and
`resolutionOrder` (their edges, aliases pointing to them and externals only they use).

## Values and imports

- `ValueRef` (decorator arguments, interceptor options, extension data): `ref.symbol` →
  `project.importRoute(ref.symbol)` → `import { exportName } from 'specifier'` + `members`.
- Classes: `ProviderNode.importRoute` (or `ClassInfo.importRoute`).
- Identities: `project.importRoute(identity)`.
- Identifiers are de-duplicated by identity order (`UserService`, `UserService$1`) — §3.3.

## `GenerateContext`

`src/extensions/generate.ts` defines `GenNode`, `GenerateContext` and implements the pure builders
(`createGenBuilders()`: `lit`, `obj`, `arr`, `ref`, `member`, `call`, `construct`, `arrow`, `code`).
The code generator (`src/codegen/context.ts`, `module.ts`, `container.ts`) adds:

- `importValue(target)` / `importType(target)`: a `GenImport` node (`target.kind: 'ref' |
  'identity' | 'module'`) registered in the module's import table; a route failure is a ZNIGHT005
  naming the extension;
- `importFrom(module, name)`: package exports used by generated code (`coerce` from
  `@znight/http`...);
- `tokenOf(target)`: provider token of a class / identity, resolving `aliases`;
- `binding(handle)`: `graph.bindings.get(handle.id)`;
- `constant(name, value, { type })`: a module-level `const` (`gen:constant` node);
- the printer: `gen:literal` → literal emitter (ValueRefs imported), `gen:object` → computed string
  keys, `gen:code` → `parts` verbatim with each value printed, `gen:arrow` params typed when a type
  node is given. Only nodes created by the builders are printed (forged objects are reported). The
  section returned by `generate()` becomes `metadata.extensions[name]`.
