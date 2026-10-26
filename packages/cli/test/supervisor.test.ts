import type { ExitStatus } from '../src/integrations/process.ts'

import { AppSupervisor } from '../src/dev/supervisor.ts'
import { delay, FakeChild, type FakeChildOptions, waitFor } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

function setup(
  child: FakeChildOptions = { exitAfterMs: 1 },
  options: { debounceMs?: number; killTimeoutMs?: number } = {},
) {
  const children: FakeChild[] = []
  const events: string[] = []
  let failSpawn = false
  const supervisor = new AppSupervisor({
    debounceMs: options.debounceMs ?? 10,
    killTimeoutMs: options.killTimeoutMs ?? 50,
    spawn: () => {
      if (failSpawn) throw new Error('spawn failed')
      const created = new FakeChild('node', ['dist/main.js'], { cwd: '/app', env: {} }, child)
      children.push(created)
      return created
    },
    events: {
      onStart: (started, restart) => events.push(`${restart ? 'restart' : 'start'}:${started.pid}`),
      onStop: (status: ExitStatus, forced) => events.push(`stop:${status.signal}${forced ? ':forced' : ''}`),
      onExit: status => events.push(`exit:${status.code}`),
      onError: error => events.push(`error:${(error as Error).message}`),
    },
  })
  return {
    supervisor,
    children,
    events,
    failNextSpawn: () => {
      failSpawn = true
    },
  }
}

describe('AppSupervisor', () => {
  it('starts the first process', async () => {
    const { supervisor, children, events } = setup()
    await supervisor.restart()
    expect(children).toHaveLength(1)
    expect(supervisor.running).toBe(true)
    expect(supervisor.current).toBe(children[0])
    expect(events).toEqual([`start:${children[0]?.pid}`])
  })

  it('stops the previous process with SIGTERM before starting the next one', async () => {
    const { supervisor, children, events } = setup()
    await supervisor.restart()
    await supervisor.restart()
    expect(children).toHaveLength(2)
    expect(children[0]?.signals).toEqual(['SIGTERM'])
    expect(children[0]?.done).toBe(true)
    expect(children[1]?.signals).toEqual([])
    expect(events).toEqual([`start:${children[0]?.pid}`, 'stop:SIGTERM', `restart:${children[1]?.pid}`])
    expect(supervisor.starts).toBe(2)
  })

  it('sends SIGKILL when the process does not exit within the kill timeout', async () => {
    const { supervisor, children, events } = setup({ exitAfterMs: undefined }, { killTimeoutMs: 20 })
    await supervisor.restart()
    const started = performance.now()
    await supervisor.restart()
    expect(performance.now() - started).toBeGreaterThanOrEqual(15)
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(events).toContain('stop:SIGKILL:forced')
    expect(children).toHaveLength(2)
  })

  it('cancels a scheduled restart', async () => {
    const { supervisor, children } = setup(undefined, { debounceMs: 20 })
    expect(supervisor.cancelRestart()).toBe(false)
    supervisor.scheduleRestart()
    expect(supervisor.cancelRestart()).toBe(true)
    expect(supervisor.cancelRestart()).toBe(false)
    await delay(40)
    expect(children).toHaveLength(0)
    supervisor.scheduleRestart()
    await waitFor(() => children.length === 1)
    await supervisor.stop()
  })

  it('debounces scheduled restarts', async () => {
    const { supervisor, children } = setup(undefined, { debounceMs: 30 })
    supervisor.scheduleRestart()
    await delay(10)
    supervisor.scheduleRestart()
    await delay(10)
    supervisor.scheduleRestart()
    expect(children).toHaveLength(0)
    await waitFor(() => children.length === 1)
    await delay(50)
    expect(children).toHaveLength(1)
  })

  it('never overlaps restarts and merges the ones requested while one is waiting', async () => {
    const { supervisor, children } = setup({ exitAfterMs: 20 })
    await supervisor.restart()
    const first = supervisor.restart()
    // requested before the first one started: merged with it
    expect(supervisor.restart()).toBe(first)
    await waitFor(() => children[0]?.signals.length === 1)
    // requested while the first one is stopping process #1: queued, the next ones merged
    const second = supervisor.restart()
    expect(second).not.toBe(first)
    expect(supervisor.restart()).toBe(second)
    await Promise.all([first, second])
    expect(children).toHaveLength(3)
    expect(children.filter(child => !child.done)).toHaveLength(1)
    // every stopped process received exactly one SIGTERM, after the previous one exited
    expect(children.slice(0, 2).map(child => child.signals)).toEqual([['SIGTERM'], ['SIGTERM']])
  })

  it('reports a process exiting by itself and starts it again on the next restart', async () => {
    const { supervisor, children, events } = setup()
    await supervisor.restart()
    children[0]?.exit(1)
    await waitFor(() => !supervisor.running)
    expect(events.at(-1)).toBe('exit:1')
    await supervisor.restart()
    expect(supervisor.running).toBe(true)
    // the crashed process is not signalled
    expect(children[0]?.signals).toEqual([])
  })

  it('keeps the last good process when no restart is scheduled', async () => {
    const { supervisor, children } = setup()
    await supervisor.restart()
    await delay(20)
    expect(supervisor.current).toBe(children[0])
    expect(children[0]?.signals).toEqual([])
  })

  it('stops with the given signal and refuses new starts', async () => {
    const { supervisor, children } = setup()
    await supervisor.restart()
    supervisor.scheduleRestart()
    await supervisor.stop('SIGINT')
    expect(children[0]?.signals).toEqual(['SIGINT'])
    expect(supervisor.running).toBe(false)
    await supervisor.restart()
    await delay(20)
    expect(children).toHaveLength(1)
  })

  it('waits for an in-progress restart when stopping', async () => {
    const { supervisor, children } = setup({ exitAfterMs: 10 })
    await supervisor.restart()
    const restarting = supervisor.restart()
    await supervisor.stop()
    await restarting
    // the restart was interrupted: no new process
    expect(children).toHaveLength(1)
    expect(supervisor.running).toBe(false)
  })

  it('kills everything at once', async () => {
    const { supervisor, children } = setup({ exitAfterMs: undefined }, { killTimeoutMs: 1000 })
    await supervisor.restart()
    const restarting = supervisor.restart() // stuck: process #1 ignores SIGTERM
    await delay(5)
    supervisor.kill()
    await restarting
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(children).toHaveLength(1)
  })

  it('reports spawn failures and keeps working', async () => {
    const { supervisor, events, failNextSpawn, children } = setup()
    failNextSpawn()
    await supervisor.restart()
    expect(events).toEqual(['error:spawn failed'])
    expect(supervisor.running).toBe(false)
    expect(children).toHaveLength(0)
  })
})
