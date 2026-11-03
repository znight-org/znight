---
"@znight/http": patch
---

The fast lane of the request pipeline also serves an `HttpResponse` carrying a plain JSON body with no header other than `content-type` and no cookie (`HttpResponse.ok(body)`, an explicit status, a custom JSON media type), byte for byte like the general pipeline: about 0.3 to 0.4 µs less per request.
