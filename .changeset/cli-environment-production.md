---
"@znight/cli": patch
---

`znight new`: the generated `AppConfig.environment` defaults to `'production'`, so an application started without `NODE_ENV` logs JSON; `znight dev` still sets `development`.
