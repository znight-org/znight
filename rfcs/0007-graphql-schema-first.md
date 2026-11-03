# RFC 0007: Schema-first GraphQL (`@znight/graphql`)

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Accepted (v0.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Date     | 2026-11-03                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Affects  | `@znight/graphql` (compiler extension: an SDL front-end, coverage and type conformance checks; runtime: GraphQL interfaces, scalar descriptions from the metadata; `@Resolver('Type')`); `@znight/compiler` (`ValidateContext.inputFiles()`, input files in `watchFiles` and the watchers); `@znight/core` (error codes ZNIGHT067–068); docs. Amends RFC 0005 decision D1 (code-first only) and its §3 non-goal "schema-first development"                                                                                                                                                      |
| Decision | **An opt-in schema-first mode.** `graphql.configure({ schema: 'src/**/*.graphql' })` makes the SDL files the source of truth: the compiler parses, merges and validates them with graphql-js at build time, binds resolvers to fields by name (NestJS schema-first conventions), checks that every field is covered and that resolver signatures conform to the SDL through the type shapes API (the gqlgen approach), and emits the same `metadata.extensions.graphql` as code-first. The runtime is unchanged apart from GraphQL interfaces. Code-first stays the default; the two modes do not mix |

**Acceptance (2026-11-03).** The owner chose the design aligned with the ecosystem (NestJS
schema-first, Apollo/graphql-tools, Spring for GraphQL, gqlgen, Netflix DGS, Ariadne): the SDL is
the source of truth, resolvers are bound by name, TypeScript types come from graphql-codegen, and
Znight adds what gqlgen adds for Go: coverage and type conformance checked at build time, with
located diagnostics. Performance stays a priority: the runtime path is the code-first one.

## 1. Summary

Code-first (RFC 0005) derives the schema from TypeScript types. Many teams, and every NestJS
schema-first application, work the other way round: the `.graphql` files are the contract shared
with clients (and with graphql-codegen on both sides), and resolvers implement it. Until now such an
application had to be rewritten type by type to move to Znight.

With `graphql.configure({ schema })`, the compiler extension reads the SDL instead of walking
TypeScript types:

```graphql
# src/events/event.graphql
type Event {
  id: ID!
  title: String!
  owner: User!
}

extend type Query {
  event(id: ID!): Event
}
```

```ts
@Resolver()
export class EventResolver {
  constructor(private readonly events: EventService) {}

  @Query()
  event(@Args('id') id: string): Promise<Event | null> {
    return this.events.find(id)
  }
}

@Resolver('Event')
export class EventFieldResolver {
  @ResolveField()
  owner(@Parent() event: Event, @Loader() users: Loader<UsersById>): Promise<User> {
    return users.load(event.ownerId)
  }
}
```

What only a compiler can add to schema-first:

1. **Coverage at build time.** A root field without resolver, a resolver for a field the SDL does
   not declare, an unknown argument, a `@Resolver('Evnt')` typo, an object field that neither a
   resolver nor the TypeScript type returned for its parent provides: each is a located diagnostic,
   not a `null` at runtime.
2. **Type conformance at build time.** Return types, parent types and arguments are compared with
   the SDL: nullability, lists, scalars, enums, union and interface members, input objects. A
   resolver returning `string | undefined` for `String!` fails the build.
3. **No SDL work at boot.** The SDL is parsed once, at build time; the generated metadata holds the
   schema as data, exactly as in code-first. Boot and execution cost are unchanged.

## 2. Goals and non-goals

Goals:

- The SDL files are the only source of truth of the schema (types, fields, arguments, defaults,
  descriptions, deprecations, enums, unions, interfaces, input objects, scalars).
- Mechanical migration from NestJS schema-first: the same decorators, binding by name.
- graphql-codegen interop: its `typescript` plugin output passes the conformance checks.
- Every problem is a diagnostic with a location (in the `.graphql` file or the TypeScript source),
  a hint and, when useful, a related location.
- The same runtime and the same metadata as code-first; same SDL artifact and `schemaHash` options.

Non-goals:

- Mixing modes (part of the schema from SDL, part from TypeScript): one source of truth (D2).
- Custom directives with runtime behaviour, `@oneOf` input objects, federation, `__resolveType`
  methods (§9).
- Generating TypeScript types: graphql-codegen does it well; Znight checks its output.
- Custom internal enum values: an enum value is its SDL name on both sides (§5.5).

## 3. Key decisions

| #   | Decision                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Opt-in through the compiler extension options: `graphql.configure({ schema: string \| string[] })`, globs relative to the project root. Without `schema`, code-first as in RFC 0005                                                                                                             |
| D2  | No mixing: with `schema`, TypeScript types never add anything to the schema (JSDoc, `@gqlName`, `@gqlHidden`, `@default` and the `number` option are ignored); TypeScript types are only checked against the SDL                                                                              |
| D3  | The SDL is parsed, merged (`extend`) and validated with graphql-js (`graphql/language`, `graphql/type`, `graphql/utilities`; the SDL rules graphql-js keeps internal are re-implemented), loaded lazily and only in schema-first mode: build-time and runtime agree on what a valid schema is. The executor is never loaded at build time |
| D4  | Binding by name, as NestJS schema-first: root fields by `@Query/@Mutation/@Subscription(name?)` (default: the method name), type fields by `@Resolver('Type')` + `@ResolveField(name?)`. `@Parent()` is optional in schema-first                                                              |
| D5  | Coverage (step 1) and type conformance (step 2) ship together, as errors. `any` and `unknown` opt out locally; a missing annotation is not checked                                                                                                                                            |
| D6  | GraphQL interfaces are supported end to end (metadata, runtime, SDL printer), for schema-first only: code-first still maps no TypeScript type to an interface (RFC 0005 §15)                                                                                                                  |
| D7  | Two new codes: ZNIGHT067 (the SDL itself) and ZNIGHT068 (the code does not match the SDL). Existing codes are reused where the meaning is the same (ZNIGHT005, 061, 062, 064, 065, 023)                                                                                                      |
| D8  | Abstract types (unions, interfaces) resolve their members from `__typename` (what graphql-codegen and NestJS applications return), with `instanceof` first when the resolvers return exported classes for them                                                                               |

## 4. User-facing API

### 4.1 Activation

```ts
// znight.config.ts
import type { ZnightOptions } from '@znight/compiler'
import graphql from '@znight/graphql/compiler'

export default {
  extensions: [graphql.configure({ schema: 'src/**/*.graphql', sdl: 'schema.graphql' })],
} satisfies ZnightOptions
```

- `schema`: a glob or a list of globs (`!` negations allowed), relative to the project root. Files
  are read in path order; `node_modules` is never matched. No file matching is ZNIGHT067.
- The files are inputs of the compile (`watchFiles`): editing, creating or deleting a matching file
  recompiles in `vite dev` and `znight generate --watch` (the Bun preload picks a new file up at its
  next start). The `sdl` artifact is never read back, even when the globs match it.
- `sdl` keeps its meaning: the artifact is the schema the runtime serves, printed like code-first
  (types sorted by name), semantically equal to the source SDL without its custom directives.
- `number` is ignored (the SDL says `Int` or `Float`).

### 4.2 Resolvers

| NestJS schema-first                         | Znight schema-first                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `@Resolver()` / `@Resolver('Event')`        | same; `@Resolver('Event', { scope: 'request' })` adds the scope          |
| `@Query()` / `@Query('name')`               | same (also `@Mutation`, `@Subscription`)                                |
| `@ResolveField()` / `@ResolveField('name')` | same, in a `@Resolver('Type')` class                                    |
| `@Parent()`, `@Args('name')`, `@Args()`     | same; `@Args('name', Schema)` validates with a Standard Schema          |
| `@Context()`, `@Info()`                     | `@Ctx()`, `@Info()`                                                     |
| DataLoader in the context                   | `@Loader() users: Loader<UsersById>`                                    |
| `@UseGuards()`, `SetMetadata`               | `@UseGuard()`, route decorators (`createRouteDecorator`), as code-first |

- A class may hold root fields and field resolvers of its type, as in NestJS.
- `@Resolver('Type')` names an object type of the SDL. It is a ZNIGHT005 error in code-first mode.
- `@ResolveField` needs `@Resolver('Type')` in schema-first mode (ZNIGHT062 otherwise); the field
  is a field of that type. `@Parent()` is optional.
- `@Args()` without a name receives every argument of the field (an object).
- Descriptions and deprecations come from the SDL; the JSDoc of resolvers is not read.

### 4.3 graphql-codegen

The recommended setup generates the TypeScript types of the SDL with the `typescript` plugin and
maps the custom scalars to the types of their `scalar<T>()` definitions:

```ts
// codegen.ts
import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: 'src/**/*.graphql',
  generates: {
    'src/graphql/types.generated.ts': {
      plugins: ['typescript'],
      config: {
        scalars: { DateTime: 'Date', EventId: '../events/event-id.ts#EventId' },
        namingConvention: { enumValues: 'keep' },
        useTypeImports: true,
      },
    },
  },
}
export default config
```

Resolvers annotate their return types and arguments with the generated types (`Promise<Event>`,
`QueryEventArgs['id']`). Enums are compared by value (the SDL name), so enum member names may follow
any naming convention; `enumValues: 'keep'` keeps them equal to the SDL. `typescript-resolvers`
types work too but are not needed: decorated classes are checked directly.

## 5. Compile-time behaviour (normative)

### 5.1 Pipeline

`validate` reads the files (`ValidateContext.inputFiles(patterns)`), parses each with
`graphql/language` `parse` (syntax errors: ZNIGHT067 at the error position), concatenates the
documents, checks it the way graphql-js SDL validation does (unique names, known types and
directives, directive locations and arguments, valid extensions; graphql-js does not export these
rules) then runs `buildASTSchema` and `validateSchema`: every GraphQL error is a ZNIGHT067 at the first AST node it names (unknown types,
duplicate names, invalid extensions, wrong kinds, interface implementations, default values...).
Then, in this order: unsupported constructs, scalars, resolver binding (coverage), conformance,
model assembly. Errors stop before emission; the generated module is the error module.

### 5.2 Unsupported constructs

- A custom directive definition is a ZNIGHT067 **warning** (once per directive, at its definition);
  the directive and its uses are left out of the served schema and the artifact.
- `@oneOf` input objects: ZNIGHT067 error (the runtime does not model them yet).
- `scalar DateTime`, `BigInt` and `JSON` without a `scalar<T>()` definition of that name are the
  built-in scalars of `@znight/graphql`; a description or another `@specifiedBy` on them is a
  ZNIGHT067 warning (the built-in one is served).
- Another scalar needs a `scalar<T>('Name', definition)` declaration of the same name (ZNIGHT067
  otherwise, with the declaration to write as hint). Its description and `@specifiedBy` come from
  the SDL.

### 5.3 Coverage (ZNIGHT068)

| Problem                                                                                     | Location                    |
| ------------------------------------------------------------------------------------------- | --------------------------- |
| A root field (`Query`, `Mutation`, `Subscription` or the `schema {}` roots) has no resolver | the SDL field               |
| `@Query('x')` (or the method name) names no field of the root type (with a suggestion)      | the decorator               |
| `@Resolver('X')`: no type `X`, or `X` is not an object type                                 | the `@Resolver` argument    |
| `@ResolveField('x')`: the type has no field `x`                                             | the decorator               |
| `@Args('x')`, or a property of an `@Args()` object type: no argument `x`                    | the decorator, the property |
| An object field without resolver that the TypeScript type returned for its parent lacks     | the SDL field               |

Two methods bound to one field are ZNIGHT061, a `@Subscription` not returning an async iterable
ZNIGHT062 (as code-first). The last row needs the TypeScript type of the parent: it is checked for
every object reached from an annotated resolver return type (§5.4).

### 5.4 Type conformance (ZNIGHT068)

Types are read with the type shapes API (`members: 'instance'`, the `scalar<T>()` types kept). The
walk starts from every resolver binding and follows object fields without resolver through the
properties of the TypeScript types, each (SDL type, TypeScript declaration) pair once.

**Output** (return types, parent properties): the TypeScript type must be assignable to the SDL type.

- `T!` rejects a TypeScript type that includes `null`, `undefined` or an optional property; `T`
  accepts anything `T` accepts plus `null` and `undefined`.
- `[T]` accepts arrays, tuples, `ReadonlyArray`, `Set`, `ReadonlySet` and `Iterable` of a
  conforming item.
- `String`: strings, string literals, string enums and branded strings (`string & { ... }`). `ID`:
  the same plus numbers. `Int`, `Float`: numbers, number literals, numeric enums, the `Int` and
  `Float` aliases. `Boolean`: booleans. `DateTime`: `Date`. `BigInt`: `bigint` or numbers. `JSON`:
  anything.
  A custom scalar: the `T` of its `scalar<T>()` declaration.
- An enum: a TypeScript enum, a union of literals or a literal whose values are SDL value names.
- An object type: an interface, class, object alias or intersection; each SDL field without
  resolver must be a property (coverage) whose type conforms. Extra properties are ignored.
- A union or an interface: each member of the TypeScript union is matched to a possible type by
  its `__typename` literal, else by its declaration name; a member matching none is a mismatch,
  and a member that is neither an exported class nor declares `__typename` cannot be told apart at
  runtime (ZNIGHT064, §6). An optional `__typename` (graphql-codegen's default) passes: the value
  must still carry it at runtime. A TypeScript type named like the abstract type itself (graphql-codegen's
  interface types) is checked against the fields of the interface.

**Input** (`@Args` parameters, input objects): the TypeScript type must accept every value
graphql-js passes.

- A nullable argument or input field without default may be absent: the TypeScript type must
  accept `undefined` (optional, `| undefined`, a parameter default); with a default it may still be
  `null`: the type must accept `null` or `undefined`. When the types reading it accept `undefined`
  but not `null`, the runtime turns `null` into `undefined` (`nullAsUndefined`, as code-first). A
  nullable list item must accept `null` (items are never converted).
- Scalars, enums and lists as in output, reversed: `String` needs `string` (a literal union is
  narrower), an enum needs every SDL value, `[T]` needs an array.
- An input object: an object type; a property the input object does not declare is a mismatch (it
  would always be `undefined`). Fields the TypeScript type leaves out are allowed.

**Not checked**: `any`, `unknown`, a missing annotation, opaque types (unresolved imports, type
parameters). Each mismatch is one diagnostic located on the TypeScript annotation, with the SDL
definition as related location and the path inside the type (`Event.owner.email`).

### 5.5 Mapping to the metadata

The model is built from the validated `GraphQLSchema`: every named type except introspection types,
the specified scalars and custom directives, sorted by name as in code-first; fields, arguments,
enum values and input fields in SDL order (extensions after the definition, in file order);
default values as external values; enum values with `value` = name; union members sorted; object
types carry `interfaces` (declaration order). Field resolvers become `resolver` bindings with the
same `invoke` as code-first. The SDL artifact and `schemaHash` are printed from this model.

## 6. Runtime changes

- **Interfaces.** `GraphQLInterfaceTypeDefinition { kind: 'interface', name, description?,
  interfaces?, fields, discriminator }` and `GraphQLObjectTypeDefinition.interfaces?`. Interface
  fields have no `resolver` (graphql-js resolves the fields of the concrete object). The boot check
  (ZNIGHT066) and the SDL printer support them. Code-first never emits them, so its metadata,
  artifact and hashes are unchanged.
- **Discriminators.** Unions and interfaces use the existing `typename` and `class` discriminators
  (`class` lists every exported class the resolvers return; its runtime falls back to `__typename`).
  ZNIGHT064 (reused) reports a TypeScript member that is neither a class nor declares `__typename`.
- **Custom scalars.** `GraphQLCustomScalarDefinition` gains optional `description`,
  `specifiedByURL` and `sdl: true`: with `sdl`, they replace the definition's, absent ones included
  (the SDL is the truth, and the served schema is the artifact).
- Nothing else changes: same execution path, same costs.

## 7. Compiler changes

- `ValidateContext.inputFiles(patterns) → readonly InputFile[]` (`{ file, relativeFile, text }`,
  sorted by path, `node_modules` excluded): non-source files an extension reads. They are part of
  `watchFiles`, and the watchers recompile when a file matching the patterns of the last compile is
  created or deleted (`isRelevantChange`).
- The boundaries rule of RFC 0005 §8.1 is amended: `@znight/graphql/compiler` may load
  `graphql/language`, `graphql/type` and `graphql/utilities`, lazily (a
  `createRequire` call in schema-first mode), never the `graphql` root entry, `graphql/execution`
  nor dataloader. Code-first compiles never load graphql-js. `tests/boundaries.test.ts` enforces
  both.

## 8. Diagnostics

| Code      | Title                     | Phase | Covers                                                                                                                                                         |
| --------- | ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZNIGHT067 | Invalid GraphQL SDL       | build | no file matches, syntax errors, graphql-js SDL and schema validation, a scalar without implementation, `@oneOf`; custom directives and built-in scalar overrides (warnings) |
| ZNIGHT068 | GraphQL schema mismatch   | build | coverage (§5.3) and type conformance (§5.4)                                                                                                                    |

Reused: ZNIGHT005 (`@Resolver('Type')` in code-first, invalid decorator arguments), ZNIGHT061 (two
resolvers for one field), ZNIGHT062 (`@ResolveField` without a type name, subscriptions), ZNIGHT064
(abstract type members), ZNIGHT065 (loaders), ZNIGHT023 (route decisions). ZNIGHT069 stays free.

## 9. Out of scope, follow-ups

- `__resolveType` methods (`@ResolveField('__resolveType')` in NestJS): today the members carry
  `__typename` or are classes.
- Custom directives with behaviour (schema transforms, `@auth`-like directives), `@oneOf`,
  federation (`@key`), `@defer`/`@stream`.
- Interfaces in code-first (TypeScript `abstract class` / `interface` hierarchies).
- Custom internal enum values (NestJS `resolvers: { Level: { Low: 1 } }`).
- A conformance severity option, should real applications need a gradual migration.

## 10. Alternatives considered

| Alternative                                                          | Why not                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Parse and validate the SDL by hand with `graphql/language` only      | Re-implements dozens of graphql-js validation rules; build and runtime could disagree on a valid schema        |
| Build the schema at boot from the SDL (`buildSchema`, as NestJS)     | Parsing at boot, no build-time coverage or conformance; two runtime paths                                     |
| Generate TypeScript types from the SDL in the compiler               | graphql-codegen does it, with options teams already use; Znight checks its output instead                    |
| Mix code-first and schema-first                                      | Two sources of truth; ambiguous ownership of descriptions, defaults and names                                 |
| Infer the parent type of `@ResolveField` from the `@Parent()` type   | Breaks the mechanical NestJS migration and needs a type name anyway when the parent is not declared           |
