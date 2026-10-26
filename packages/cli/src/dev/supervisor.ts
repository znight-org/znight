/**
 * Restart orchestration of `znight dev`: one application process at a time, restarted (debounced)
 * after each successful build. Stopping sends SIGTERM, waits for the exit and sends SIGKILL after a
 * timeout. Restarts are serialised and coalesced: a burst of builds causes one restart with the
 * latest output. A failed build simply does not schedule a restart, so the last good process keeps
 * running.
 */
import type { ChildHandle, ExitStatus } from '../integrations/process.ts'

/** Notifications of an {@link AppSupervisor}. */
export interface SupervisorEvents {
  /** A process was started (`restart` is false for the first one). */
  onStart?(child: ChildHandle, restart: boolean): void
  /** A process stopped by the supervisor exited (`forced`: it needed SIGKILL). */
  onStop?(status: ExitStatus, forced: boolean): void
  /** The current process exited by itself (crash, or the application ended). */
  onExit?(status: ExitStatus): void
  /** Starting a process failed synchronously. */
  onError?(error: unknown): void
}

/** Options of {@link AppSupervisor}. */
export interface AppSupervisorOptions {
  /** Starts a new application process. */
  readonly spawn: () => ChildHandle
  /** Delay applied by {@link AppSupervisor.scheduleRestart}. Default 100 ms. */
  readonly debounceMs?: number
  /** Time a process gets to exit after SIGTERM before SIGKILL. Default 5000 ms. */
  readonly killTimeoutMs?: number
  readonly events?: SupervisorEvents
}

/** Keeps one application process running and restarts it on demand. */
export class AppSupervisor {
  readonly #spawn: () => ChildHandle
  readonly #debounceMs: number
  readonly #killTimeoutMs: number
  readonly #events: SupervisorEvents
  readonly #stopping = new Set<ChildHandle>()
  #current: ChildHandle | undefined
  #debounce: ReturnType<typeof setTimeout> | undefined
  #queue: Promise<void> = Promise.resolve()
  #queued = false
  #closed = false
  #started = 0

  constructor(options: AppSupervisorOptions) {
    this.#spawn = options.spawn
    this.#debounceMs = options.debounceMs ?? 100
    this.#killTimeoutMs = options.killTimeoutMs ?? 5000
    this.#events = options.events ?? {}
  }

  /** Whether an application process is running. */
  get running(): boolean {
    return this.#current !== undefined
  }

  /** The running process. */
  get current(): ChildHandle | undefined {
    return this.#current
  }

  /** Number of processes started so far. */
  get starts(): number {
    return this.#started
  }

  /** Restarts after `debounceMs`; calls in between postpone it. */
  scheduleRestart(): void {
    if (this.#closed) return
    if (this.#debounce !== undefined) clearTimeout(this.#debounce)
    this.#debounce = setTimeout(() => {
      this.#debounce = undefined
      void this.restart()
    }, this.#debounceMs)
  }

  /**
   * Stops the current process (if any) and starts a new one. Restarts never overlap; a restart
   * requested while another one is waiting to run is merged with it.
   */
  restart(): Promise<void> {
    if (this.#closed) return this.#queue
    if (this.#queued) return this.#queue
    this.#queued = true
    this.#queue = this.#queue
      .then(async () => {
        this.#queued = false
        if (this.#closed) return
        await this.#stopCurrent('SIGTERM')
        if (this.#closed) return
        this.#startNew()
      })
      .catch((error: unknown) => {
        // keep the queue usable: a failing listener must not block later restarts
        this.#queued = false
        this.#events.onError?.(error)
      })
    return this.#queue
  }

  /** Stops the current process with `signal` (SIGKILL after the timeout) and refuses new starts. */
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.#closed = true
    if (this.#debounce !== undefined) {
      clearTimeout(this.#debounce)
      this.#debounce = undefined
    }
    await this.#queue
    await this.#stopCurrent(signal)
  }

  /** Immediately SIGKILLs every process (a second Ctrl+C). */
  kill(): void {
    this.#closed = true
    if (this.#debounce !== undefined) clearTimeout(this.#debounce)
    this.#current?.kill('SIGKILL')
    for (const child of this.#stopping) child.kill('SIGKILL')
  }

  #startNew(): void {
    let child: ChildHandle
    try {
      child = this.#spawn()
    } catch (error) {
      this.#events.onError?.(error)
      return
    }
    const restart = this.#started > 0
    this.#started++
    this.#current = child
    void child.exited.then(status => {
      if (this.#current !== child) return
      this.#current = undefined
      this.#events.onExit?.(status)
    })
    this.#events.onStart?.(child, restart)
  }

  async #stopCurrent(signal: NodeJS.Signals): Promise<void> {
    const child = this.#current
    if (child === undefined) return
    this.#current = undefined
    this.#stopping.add(child)
    try {
      child.kill(signal)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), this.#killTimeoutMs)
      })
      const first = await Promise.race([child.exited, timeout])
      clearTimeout(timer)
      if (first === 'timeout') {
        child.kill('SIGKILL')
        this.#events.onStop?.(await child.exited, true)
      } else {
        this.#events.onStop?.(first, false)
      }
    } finally {
      this.#stopping.delete(child)
    }
  }
}
