# Znight RFCs

Design documents for significant changes. Each RFC is discussed before implementation.

| RFC                                | Title                                     | Status           |
| ---------------------------------- | ----------------------------------------- | ---------------- |
| [0001](./0001-security.md)         | Security (route decisions, CORS, headers) | Accepted (v0.1)  |
| [0002](./0002-openapi.md)          | `@znight/openapi`                         | Accepted (v0.1)  |
| [0003](./0003-websocket.md)        | `@znight/websocket`                       | Deferred to v0.2 |
| [0004](./0004-schedule.md)         | `@znight/schedule`                        | Accepted (v0.1)  |
| [0005](./0005-graphql.md)          | `@znight/graphql`                         | Deferred to v0.2 |
| [0006](./0006-http-cookies-sse.md) | HTTP cookies and Server-Sent Events       | Accepted (v0.1)  |

## Error code allocation

`ZNIGHT001`–`ZNIGHT029` are core/compiler/http codes (`ZNIGHT023` = missing route decision, RFC 0001).
Package ranges: `ZNIGHT030`–`039` openapi, `ZNIGHT040`–`049` schedule, `ZNIGHT050`–`059` websocket
(reserved, v0.2), `ZNIGHT060`–`069` graphql (reserved, v0.2). RFCs written before this allocation
may use other numbers: this table wins.
