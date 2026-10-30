---
"@znight/http": patch
---

Faster Node.js adapters, with the same responses: the Fastify adapter serves a Znight route from its `onRequest` hook when no other hook needs Fastify's lifecycle (no content type parsing) and writes text replies on the raw response when no `onSend`/`onResponse` hook runs; the node, Fastify and Express adapters read request bodies and count in-flight requests without closures or map lookups per request.
