---
"@znight/graphql": patch
"@znight/compiler": patch
"@znight/core": patch
---

Schema-first GraphQL (RFC 0007): `graphql.configure({ schema: 'src/**/*.graphql' })` makes the SDL files the schema, binds resolvers by name (`@Resolver('Type')`, `@ResolveField()`), checks coverage and type conformance at build time (ZNIGHT067, ZNIGHT068) and supports GraphQL interfaces; the compiler gains `ValidateContext.inputFiles()`.
