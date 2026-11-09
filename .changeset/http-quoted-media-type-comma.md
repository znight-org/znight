---
"@znight/http": patch
---

`matchesMediaType()` and upload part types accept a comma inside a quoted parameter value (`multipart/form-data; boundary="a,b"`) and still refuse a list of types.
