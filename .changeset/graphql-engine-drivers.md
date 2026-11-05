---
"@znight/graphql": minor
---

GraphQL drivers, milestone 1 (RFC 0009): `plugin.engine`, a `GraphQLEngine` whose graphql-js-shaped `parse`, `validate`, `execute` and `subscribe` run the schema with its guards, loaders, request scope, error formatting (as `GraphQLError` instances) and hook; the `GraphQLDriver` contract and the `driver` option, whose routes are mounted in the `HttpPlugin` pipeline; `GraphQLContext.serverContext`. The built-in transport stays the default with an unchanged hot path.
