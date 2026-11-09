---
"@znight/compiler": patch
---

Vite plugin: a dev server restart that fails no longer detaches the plugin from the server still running; the new server replaces the old one only when Vite closes it for the restart.
