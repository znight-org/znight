---
"@znight/messaging": patch
---

SQS: the degraded dead-letter copy (without `x-znight-error` and the headers) is sent only when SQS refuses the copy as invalid; throttling, KMS and permission failures release the message for a full copy later.
