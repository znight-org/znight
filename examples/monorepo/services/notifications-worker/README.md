# notifications-worker

Consumes the user events (`user-events` queue) and sends welcome / goodbye notifications, with the
providers and the messaging contract of [`@znight-examples/shared`](../../packages/shared). Part of
the [monorepo example](../../README.md).

```sh
bun run build
WORKER_STDIN_EVENTS=true bun run start       # type user events on stdin (npm start works too)
{"type":"user.registered","payload":{"id":"u1","email":"ada@example.com","name":"Ada","at":"2026-01-01T00:00:00Z"}}
{"type":"user.deleted","payload":{"id":"u1","at":"2026-01-02T00:00:00Z"}}

bun run test                                 # TestBed / TestApp with the in-memory broker
bun run test:e2e                             # + end-to-end on Node.js and Bun
```

| Variable              | Default | Description                                          |
| --------------------- | ------- | ---------------------------------------------------- |
| `WORKER_STDIN_EVENTS` | `false` | Publish the user events read from stdin (local runs) |
| `WORKER_HEARTBEAT_MS` | `60000` | Interval of the liveness log line                    |
| `LOG_LEVEL`           | `info`  | `debug`, `info`, `warn`...                           |

The broker is in memory (`memory()`); use `rabbitmq()`, `sqs()` or `kafka()` from
`@znight/messaging/<driver>` in production.
