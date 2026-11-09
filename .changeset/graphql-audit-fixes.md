---
"@znight/graphql": patch
---

Migration note for the ZNIGHT023 boot check shipped in 0.6.3: a field decision of a group that an application guard enforces (`static enforces`, even an HTTP-only guard) is reported at boot when no guard of the field's GraphQL chain enforces it. An application or a resolver `TestApp` that booted on 0.6.2 without that guard in `GraphQLPlugin.configure({ guards })` fails to boot: register the guard there, or set `enforcement: 'warn'` where it is intended.
