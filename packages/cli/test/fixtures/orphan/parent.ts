// A stand-in for `znight dev`: starts the application like the CLI does (detached, with the orphan
// guard), prints its pid, then waits to be killed.
// Usage: bun --conditions=@znight/source parent.ts <runtime executable> <node|bun> <app behaviour> <marker>
import { orphanGuard } from '../../../src/dev/orphan.ts'
import { spawnProcess } from '../../../src/integrations/process.ts'

const [executable = '', runtime = 'node', behaviour = 'graceful', marker = ''] = process.argv.slice(2)
const guard = orphanGuard(runtime === 'bun' ? 'bun' : 'node', {
  parentPid: process.pid,
  pollMs: 50,
  killTimeoutMs: 1000,
})
if (guard === undefined) throw new Error('the orphan guard module was not found')
const app = new URL('./app.mjs', import.meta.url).pathname
const child = spawnProcess(executable, [...guard.args, app, behaviour, marker], {
  cwd: process.cwd(),
  env: { ...process.env, ...guard.env },
  stdio: 'ignore',
  detached: true,
})
process.stdout.write(`${child.pid}\n`)
setInterval(() => {}, 1000)
