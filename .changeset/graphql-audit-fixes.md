---
"@znight/graphql": minor
---

Fix audit findings: linear SDL comment check, ZNIGHT023 for decisions only an HTTP-only guard enforces, a size-bounded document cache, abort signal listeners that no longer leak and follow delayed executions, ZNIGHT060 for alias cycles, and a per-principal response cache example.

Breaking: ZNIGHT023 now also reports, at boot, a field decision of a group that an application guard enforces (`static enforces`, even an HTTP-only guard) when no guard of the field's GraphQL chain enforces it. An application or a resolver `TestApp` that booted on 0.6 without that guard in `GraphQLPlugin.configure({ guards })` fails to boot: register the guard there, or set `enforcement: 'warn'` where it is intended.
