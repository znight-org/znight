---
"@znight/messaging": patch
---

Redis Streams driver at `@znight/messaging/redis` (ioredis 5.4+ or 6 as an optional peer, Valkey works the same): a stream per queue read through consumer groups, retries, releases and dead letters as an atomic copy plus `XACK`, delayed retries and delayed publishing through a sorted set per stream, crashed consumers' entries claimed back with `XAUTOCLAIM`, `MAXLEN ~` trimming and `WAIT` for replicas (RFC 0014).
