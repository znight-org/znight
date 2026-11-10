# Znight RFCs

Design documents for significant changes. Each RFC is discussed before implementation.

| RFC                                           | Title                                     | Status                                |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| [0001](./0001-security.md)                    | Security (route decisions, CORS, headers) | Implemented (0.1.0)                   |
| [0002](./0002-openapi.md)                     | `@znight/openapi`                         | Implemented (0.1.0)                   |
| [0003](./0003-websocket.md)                   | `@znight/websocket`                       | Implemented (0.6.0)                   |
| [0004](./0004-schedule.md)                    | `@znight/schedule`                        | Implemented (0.1.0)                   |
| [0005](./0005-graphql.md)                     | `@znight/graphql`                         | Implemented (0.2.0)                   |
| [0006](./0006-http-cookies-sse.md)            | HTTP cookies and Server-Sent Events       | Implemented (0.1.0)                   |
| [0007](./0007-graphql-schema-first.md)        | Schema-first GraphQL (`@znight/graphql`)  | Implemented (0.2.1)                   |
| [0008](./0008-graphql-errors-as-data.md)      | Errors as data in `@znight/graphql`       | Implemented (0.2.1)                   |
| [0009](./0009-graphql-drivers.md)             | GraphQL drivers (`@znight/graphql`)       | M1–M2 implemented (0.3.0), M3 planned |
| [0010](./0010-custom-parameter-decorators.md) | Custom parameter decorators               | Implemented (0.4.0)                   |
| [0011](./0011-application-events.md)          | Application events (`@znight/events`)     | Implemented (0.5.0)                   |
| [0012](./0012-messaging-pubsub.md)            | Pub/Sub driver (`@znight/messaging`)      | Accepted (implemented, unreleased)    |
| [0013](./0013-config-secret-managers.md)      | Secret-store loaders (`@znight/config`)   | Accepted (implemented, unreleased)    |
| [0014](./0014-messaging-drivers.md)           | Messaging drivers (`@znight/messaging`)   | Accepted (M1 implemented, unreleased) |

## Error code allocation

`ZNIGHT001`–`ZNIGHT029` are core/compiler/http codes (`ZNIGHT023` = missing route decision, RFC 0001).
Package ranges: `ZNIGHT030`–`039` openapi, `ZNIGHT040`–`049` schedule, `ZNIGHT050`–`059` websocket
(`050`–`051` allocated by RFC 0003), `ZNIGHT060`–`069` graphql (`060`–`066` allocated by RFC 0005, `067`–`068` by RFC
0007), `ZNIGHT070`–`079` events (`070` allocated by RFC 0011). RFCs written before this allocation may
use other numbers: this table wins.
