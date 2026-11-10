# @znight/cli

## 0.7.3

### Patch Changes

- Updated dependencies [bb1c8f1]
  - @znight/core@0.7.3
  - @znight/compiler@0.7.3
  - @znight/openapi@0.7.3

## 0.7.2

### Patch Changes

- @znight/compiler@0.7.2
  - @znight/core@0.7.2
  - @znight/openapi@0.7.2

## 0.7.1

### Patch Changes

- 3cbfd77: The `homepage` of every package points to its page of the documentation site.
- Updated dependencies [3cbfd77]
  - @znight/compiler@0.7.1
  - @znight/core@0.7.1
  - @znight/openapi@0.7.1

## 0.7.0

### Patch Changes

- 209fe6a: `znight new`: the generated `AppConfig.environment` defaults to `'production'`, so an application started without `NODE_ENV` logs JSON; `znight dev` still sets `development`.
- 4bb74a2: `znight new`: the OpenAPI document is `src/openapi.ts` and sets `info` (title, description, version), `--openapi-ui none` (and a "No UI" choice) configures no API reference UI, and observability logs are pretty-printed in development (`NODE_ENV`, read through `AppConfig.environment` with `config`; `pino-pretty` added as a dev dependency) and JSON in production, with metrics and tracing off.
- Updated dependencies [8dbbb4b]
  - @znight/openapi@0.7.0
  - @znight/compiler@0.7.0
  - @znight/core@0.7.0

## 0.6.6

### Patch Changes

- Updated dependencies [d85b11b]
  - @znight/compiler@0.6.6
  - @znight/openapi@0.6.6
  - @znight/core@0.6.6

## 0.6.5

### Patch Changes

- @znight/openapi@0.6.5
  - @znight/compiler@0.6.5
  - @znight/core@0.6.5

## 0.6.4

### Patch Changes

- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
  - @znight/compiler@0.6.4
  - @znight/core@0.6.4
  - @znight/openapi@0.6.4

## 0.6.3

### Patch Changes

- 345cd53: Cancel znight dev restarts already in flight, never restart while it shuts down, stop generate --watch cleanly on Ctrl+C, and let the application stop gracefully on Ctrl+C on Windows.
- a962d75: `znight new`: Fastify is the default adapter, new `graphql` and `websocket` features, `--openapi-ui scalar|swagger`, a named logger with the `observability` feature, and a multi-stage `Dockerfile` (`--no-docker` to skip it).
- Updated dependencies [345cd53]
- Updated dependencies [0eeac37]
- Updated dependencies [dede0c2]
  - @znight/openapi@0.6.3
  - @znight/compiler@0.6.3
  - @znight/core@0.6.3

## 0.6.2

### Patch Changes

- @znight/compiler@0.6.2
  - @znight/core@0.6.2
  - @znight/openapi@0.6.2

## 0.6.1

### Patch Changes

- @znight/openapi@0.6.1
  - @znight/compiler@0.6.1
  - @znight/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [f6cbef6]
  - @znight/core@0.6.0
  - @znight/openapi@0.6.0
  - @znight/compiler@0.6.0

## 0.5.1

### Patch Changes

- @znight/compiler@0.5.1
  - @znight/core@0.5.1
  - @znight/openapi@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [469d6bf]
  - @znight/core@0.5.0
  - @znight/compiler@0.5.0
  - @znight/openapi@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [3bb4597]
  - @znight/core@0.4.0
  - @znight/compiler@0.4.0
  - @znight/openapi@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [75f4b8c]
  - @znight/core@0.3.0
  - @znight/compiler@0.3.0
  - @znight/openapi@0.3.0

## 0.2.2

### Patch Changes

- @znight/compiler@0.2.2
  - @znight/core@0.2.2
  - @znight/openapi@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [1ecae4f]
  - @znight/compiler@0.2.1
  - @znight/core@0.2.1
  - @znight/openapi@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [b6119e6]
  - @znight/compiler@0.2.0
  - @znight/openapi@0.2.0
  - @znight/core@0.2.0

## 0.1.4

### Patch Changes

- c21ef01: Type shapes gain instance members (getters, visibility), enum members and literal order; extensions can declare lazy edges and emit extra files, which `znight generate --check` reports when stale.
- Updated dependencies [1fb7b0e]
- Updated dependencies [c21ef01]
- Updated dependencies [c21ef01]
  - @znight/openapi@0.1.4
  - @znight/compiler@0.1.4
  - @znight/core@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [39f7f5f]
- Updated dependencies [39f7f5f]
  - @znight/core@0.1.3
  - @znight/compiler@0.1.3
  - @znight/openapi@0.1.3

## 0.1.2

### Patch Changes

- @znight/openapi@0.1.2
  - @znight/compiler@0.1.2
  - @znight/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [dc8ac11]
  - @znight/compiler@0.1.1
  - @znight/openapi@0.1.1
  - @znight/core@0.1.1

## 0.1.0

### Initial release

- First public release of `@znight/cli`. Znight CLI: scaffold projects, generate code, run dev server and builds.
