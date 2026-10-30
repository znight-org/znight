---
"@znight/http": patch
---

Faster serialisation and request bodies, with the same responses: response header records stay in V8's fast mode (about 100 ns per request on Node.js), text bodies are encoded once, `content-type` values are parsed once per distinct value, the request context parses its buffered body without an extra promise, and `isHttpResponse` answers object literals and arrays at once.
