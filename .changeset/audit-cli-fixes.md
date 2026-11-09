---
"@znight/cli": patch
---

Cancel znight dev restarts already in flight, never restart while it shuts down, stop generate --watch cleanly on Ctrl+C, and let the application stop gracefully on Ctrl+C on Windows.
