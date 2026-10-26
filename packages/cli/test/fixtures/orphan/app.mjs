// The application started by parent.ts: records its environment, then what stops it.
// Usage: app.mjs <graceful|stubborn|fork> <marker file>
import { fork } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [behaviour, marker] = process.argv.slice(2)
const record = line => appendFileSync(marker, `${line}\n`)

if (process.env.ZNIGHT_FORKED === '1') {
  // a process the application started: never guarded (its parent is the application)
  record(`forked ${process.pid}`)
  setInterval(() => {}, 1000)
} else {
  process.on('SIGTERM', () => {
    record('SIGTERM')
    if (behaviour !== 'stubborn') process.exit(0)
  })
  if (behaviour === 'fork') {
    fork(new URL(import.meta.url).pathname, process.argv.slice(2), {
      env: { ...process.env, ZNIGHT_FORKED: '1' },
      stdio: 'ignore',
      detached: true,
    }).unref()
  }
  record(`ready ${process.env.ZNIGHT_DEV_PARENT ?? 'no-guard-variable'}`)
  setInterval(() => {}, 1000)
}
