---
"@znight/core": minor
"@znight/compiler": minor
"@znight/http": minor
"@znight/graphql": minor
"@znight/messaging": minor
"@znight/testing": minor
---

Custom parameter decorators (RFC 0010): `createParamDecorator<T, D>({ http, graphql, messaging })` defines a `@CurrentUser()` of your own, checked at build time (target, transport, data argument, value type) and called directly by the generated `invoke` of routes, GraphQL fields and message handlers; resolvers are functions or `ParamResolver` providers in any scope. The compiler adds `AnalyzeContext.paramDecorator` and `TypeHelpers.assignable` to the extension API; `TestApp` instantiates parameter resolvers with the controllers, resolvers and consumers.
