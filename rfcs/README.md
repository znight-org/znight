# Znight RFCs

Design documents for significant changes. Each RFC is discussed before implementation.

| RFC                                      | Title                                     | Status             |
| ---------------------------------------- | ----------------------------------------- | ------------------ |
| [0001](./0001-security.md)               | Security (route decisions, CORS, headers) | Accepted (v0.1)    |
| [0002](./0002-openapi.md)                | `@znight/openapi`                         | Accepted (v0.1)    |
| [0003](./0003-websocket.md)              | `@znight/websocket`                       | Accepted (planned) |
| [0004](./0004-schedule.md)               | `@znight/schedule`                        | Accepted (v0.1)    |
| [0005](./0005-graphql.md)                | `@znight/graphql`                         | Accepted (v0.2)    |
| [0006](./0006-http-cookies-sse.md)       | HTTP cookies and Server-Sent Events       | Accepted (v0.1)    |
| [0007](./0007-graphql-schema-first.md)   | Schema-first GraphQL (`@znight/graphql`)  | Accepted (v0.2)    |
| [0008](./0008-graphql-errors-as-data.md) | Errors as data in `@znight/graphql`       | Accepted (v0.2)    |
| [0009](./0009-graphql-drivers.md)        | GraphQL drivers (`@znight/graphql`)       | Proposed           |
| [0011](./0011-application-events.md)     | Application events (`@znight/events`)     | Proposed           |

## Error code allocation

`ZNIGHT001`–`ZNIGHT029` are core/compiler/http codes (`ZNIGHT023` = missing route decision, RFC 0001).
Package ranges: `ZNIGHT030`–`039` openapi, `ZNIGHT040`–`049` schedule, `ZNIGHT050`–`059` websocket
(reserved, RFC 0003), `ZNIGHT060`–`069` graphql (`060`–`066` allocated by RFC 0005, `067`–`068` by RFC
0007). `ZNIGHT070`–`079` is proposed for `@znight/events` (RFC 0011, not allocated until accepted). RFCs written before this allocation may use other numbers: this table wins.
