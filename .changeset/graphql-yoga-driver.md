---
"@znight/graphql": minor
---

GraphQL drivers, milestone 2 (RFC 0009): `@znight/graphql/yoga` serves the schema with GraphQL Yoga 6 (`yogaDriver()`, `yogaContext()`; `graphql-yoga` is an optional peer dependency) on the engine, which parses, validates and executes every operation, on every adapter, on Node.js and Bun; `describeDriverConformance()` in `@znight/graphql/testing` runs the scenarios every driver passes.
