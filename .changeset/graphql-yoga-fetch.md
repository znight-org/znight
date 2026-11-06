---
"@znight/graphql": patch
---

The Yoga driver is about twice as fast on Node.js: Yoga keeps its default Fetch API (the `@whatwg-node` ponyfills, instead of undici), its responses are converted for `HttpPlugin` (a JSON body sent as text with its length, an event stream still streamed), and request bodies are no longer piped through Yoga's own size limit (the route's body limit already applies).
