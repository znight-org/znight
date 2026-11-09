---
"@znight/config": patch
---

`vault()` rejects a token or namespace that is not a valid header value without leaking it, `vault()` and `awsSecretsManager()` validate their numeric options (ZNIGHT012), cap the retry backoff and cancel the other reads once one fails, and `ConfigSource.keys()` no longer expands cyclic values.
