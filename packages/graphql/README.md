# @znight/graphql

Code-first GraphQL for [Znight](../../README.md): the TypeScript types are the schema. Resolvers
are providers marked with `@Resolver`, `@Query`, `@Mutation`, `@Subscription` and `@ResolveField`;
the compiler extension (`@znight/graphql/compiler`) follows every type their signatures reach and
derives the complete schema at build time, with descriptions and deprecations taken from JSDoc. At
runtime, `GraphQLPlugin` serves it on graphql-js 17 through the HTTP plugin, with DataLoader batching
and subscriptions over Server-Sent Events. The design is [RFC 0005](../../rfcs/0005-graphql.md); the
package is in progress and not published yet.

```sh
# bun
bun add @znight/core @znight/http @znight/graphql graphql
bun add -d @znight/compiler vite

# npm
npm install @znight/core @znight/http @znight/graphql graphql
npm install -D @znight/compiler vite
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only). `@znight/http` and `graphql` 17 are required peer
dependencies; `dataloader` is a dependency.

```ts
import { Args, type ID, Query, Resolver } from '@znight/graphql'

interface Book {
  readonly id: ID
  readonly title: string
}

@Resolver()
export class BookResolver {
  /** One book. */
  @Query()
  book(@Args('id') id: ID): Book | null {
    return id === '1' ? { id, title: 'Dune' } : null
  }
}
```

## Compiler contract

The compiler extension generates `metadata.extensions.graphql` (`GraphQLMetadata`, declared in
[`src/metadata.ts`](./src/metadata.ts)): the schema as data, sorted by type name, with one
`invoke` function per resolver method. Type references are strings in graphql-js' canonical form
(`'[Book!]!'`), and `schemaHash` is the first 16 hexadecimal characters of the SHA-256 of the SDL
printed by `src/sdl.ts`, byte-identical to graphql-js `printSchema()` of the schema the plugin builds.

The generated `invoke` functions call two runtime helpers, kept stable:

- `validateArgs(schema, value, label)`, exported from `@znight/graphql`: validates an argument with
  a Standard Schema and returns its output, synchronously when the schema validates synchronously
  (a promise otherwise, which the `async` invoker awaits); a failure is a `GraphQLException`
  `BAD_USER_INPUT` whose `extensions.issues` lists `{ path, message }`. `label` is the argument
  name, or `'arguments'` for `@Args(Schema)` without name.
- `GraphQLContext.loader(token)`: the DataLoader of the current execution (one operation, or one
  subscription event) for a loader provider token.

Everything else in the section is data the plugin interprets at boot: it checks the section
structurally (version, roots, names, type references, bindings, discriminators, scalars, groups),
builds the schema with graphql-js constructors and fails with one ZNIGHT066 error listing every
problem. Null handling (`nullAsUndefined`) is applied before `invoke`, by normalisers built at boot
only for the fields that need one; a field without guards nor normaliser calls `invoke` directly.
