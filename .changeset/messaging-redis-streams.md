---
"@znight/messaging": patch
---

Redis Streams driver at `@znight/messaging/redis` (Redis 7.0+ or Valkey, ioredis 5.4+ or 6 as an optional peer): a stream per queue read through consumer groups, retries and releases as an atomic copy plus `XACK` to a retry stream per group (fan-outs never see another group's retries), dead letters to a dead-letter stream, delayed retries and delayed publishing through sorted sets, crashed consumers' entries claimed back with `XAUTOCLAIM`, a housekeeping pass that trims what every group acknowledged and removes the consumers of crashed processes, `MAXLEN ~` and `WAIT` for replicas (RFC 0014).
