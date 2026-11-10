---
"@znight/cli": patch
---

`znight new`: the OpenAPI document is `src/openapi.ts` and sets `info` (title, description, version), `--openapi-ui none` (and a "No UI" choice) configures no API reference UI, and observability logs are pretty-printed in development (`NODE_ENV`, read through `AppConfig.environment` with `config`; `pino-pretty` added as a dev dependency) and JSON in production, with metrics and tracing off.
