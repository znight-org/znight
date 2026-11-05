---
"@znight/http": patch
"@znight/graphql": minor
---

`PluginHttpRoutes.onHttpDrain()`: `HttpPlugin` tells the plugins serving routes that it starts draining, whatever the plugin order, so they end the streams it does not know of. The engine's subscriptions end there, and a route-mounted GraphQL driver stops once the drain is over (requests in flight are served, a stopped driver answers 503). The Yoga driver takes `application/json` `POST` bodies only (415 otherwise, like the built-in transport: no CSRF through forms), masks errors thrown outside the engine, and refuses Yoga's `batching` and `multipart` options (ZNIGHT066).
