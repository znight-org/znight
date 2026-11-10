---
"@znight/http": patch
---

`HttpResponse.file()` accepts a lazy file (`{ size, etag?, lastModified?, type?, name?, load() }`): conditional requests and ranges are evaluated from its metadata, and `load()` is called only when a body is sent (never for a 304, a 412 or a `HEAD` request). A weak entity tag no longer satisfies `If-Match` nor `If-Range`, and `If-Match` / `If-None-Match` lists are split outside quotes, so an entity tag containing a comma (`"3,7"`) matches.
