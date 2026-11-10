---
"@znight/schedule": patch
---

Report failed runs (and lock store failures) on the `error:report` hook, with the job context; a run honouring the abort of a shutdown or a removal is not reported.
