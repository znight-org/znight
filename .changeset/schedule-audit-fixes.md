---
"@znight/schedule": patch
---

Fix audit findings: out-of-range epochs no longer hang `parseCron().next()`, linear duration error hints, a bounded zone year cache, early first lease extension after a slow acquire, runs aborted on dispose and while waiting for their lease, and queued manual runs kept on `pause()`.
