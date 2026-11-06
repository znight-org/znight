# @znight/messaging

## 0.6.1

### Patch Changes

- @znight/compiler@0.6.1
  - @znight/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [f6cbef6]
  - @znight/core@0.6.0
  - @znight/compiler@0.6.0

## 0.5.1

### Patch Changes

- 61bc2c8: RabbitMQ: a consumer whose queue is gone when it resubscribes (`404 NOT_FOUND`, e.g. a queue deleted while the driver was declaring it again after the broker cancelled the consumer) declares the queue again before the next attempt instead of retrying forever.
- @znight/compiler@0.5.1
  - @znight/core@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [469d6bf]
  - @znight/core@0.5.0
  - @znight/compiler@0.5.0

## 0.4.0

### Minor Changes

- 3bb4597: Custom parameter decorators (RFC 0010): `createParamDecorator<T, D>({ http, graphql, messaging })` defines a `@CurrentUser()` of your own, checked at build time (target, transport, data argument, value type) and called directly by the generated `invoke` of routes, GraphQL fields and message handlers; resolvers are functions or `ParamResolver` providers in any scope. The compiler adds `AnalyzeContext.paramDecorator` and `TypeHelpers.assignable` to the extension API; `TestApp` instantiates parameter resolvers with the controllers, resolvers and consumers.

### Patch Changes

- Updated dependencies [3bb4597]
  - @znight/core@0.4.0
  - @znight/compiler@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [75f4b8c]
  - @znight/core@0.3.0
  - @znight/compiler@0.3.0

## 0.2.2

### Patch Changes

- @znight/compiler@0.2.2
  - @znight/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [1ecae4f]
  - @znight/compiler@0.2.1
  - @znight/core@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [b6119e6]
  - @znight/compiler@0.2.0
  - @znight/core@0.2.0

## 0.1.4

### Patch Changes

- 1fb7b0e: Update development dependencies: @biomejs/biome, tsdown, @aws-sdk/client-secrets-manager, @aws-sdk/client-sqs and @cfworker/json-schema.
- Updated dependencies [c21ef01]
- Updated dependencies [c21ef01]
  - @znight/compiler@0.1.4
  - @znight/core@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [39f7f5f]
- Updated dependencies [39f7f5f]
  - @znight/core@0.1.3
  - @znight/compiler@0.1.3

## 0.1.2

### Patch Changes

- @znight/compiler@0.1.2
  - @znight/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [dc8ac11]
  - @znight/compiler@0.1.1
  - @znight/core@0.1.1

## 0.1.0

### Initial release

- First public release of `@znight/messaging`. Znight messaging plugin: consumers, retries and dead-letter queues with RabbitMQ, SQS or Kafka.
