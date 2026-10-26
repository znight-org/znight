/**
 * Preloaded into the application by `znight dev` (see `orphan.ts`): stops the application when the
 * CLI that started it is gone without stopping it (`kill -9`, the OOM killer).
 *
 * Configured by `ZNIGHT_DEV_PARENT` (removed from the environment right away: the processes the
 * application starts, `fork()` included, are left alone), and only in the process the CLI started
 * (whose parent is the CLI). Every poll interval it checks that it was not re-parented and that the
 * CLI still exists (an unref'd timer: it never keeps the application alive). Once the CLI is gone,
 * the application gets SIGTERM (its process group when it leads one, as the CLI would send it), so
 * it stops gracefully, then SIGKILL after the kill timeout.
 */
import { ORPHAN_GUARD_ENV, parseOrphanGuard } from './orphan.ts'

const settings = parseOrphanGuard(process.env[ORPHAN_GUARD_ENV])
Reflect.deleteProperty(process.env, ORPHAN_GUARD_ENV)

if (settings !== undefined && process.ppid === settings.parentPid) {
  const { parentPid, pollMs, killTimeoutMs } = settings
  const poll = setInterval(() => {
    if (process.ppid === parentPid && isAlive(parentPid)) return
    clearInterval(poll)
    setTimeout(() => signal('SIGKILL'), killTimeoutMs).unref()
    signal('SIGTERM')
  }, pollMs)
  poll.unref()
}

/** Whether `pid` exists (EPERM: it does, but is not the CLI, which runs as the same user). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Signals the process group of the application (it leads one when detached), else the process. */
function signal(name: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32') {
      process.kill(-process.pid, name)
      return
    }
  } catch {
    // not a group leader
  }
  process.kill(process.pid, name)
}
