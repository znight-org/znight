---
"@znight/messaging": patch
---

Kafka: the `maxRetryDelayMs` cap of a retry record runs from when it was fetched, so records queued behind far-future ones no longer wait `maxRetryDelayMs` each.
