---
"@znight/cli": patch
---

`znight new`: the OpenAPI document is `src/openapi.ts` and sets `info` (title, description, version), `--openapi-ui none` (and a "No UI" choice) configures no API reference UI, and observability logs are pretty-printed (`pino-pretty` added) with metrics and tracing off.
