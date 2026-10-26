import { EventEmitter } from 'node:events'

import { Application, type ApplicationOptions, type Plugin, type ProcessLike, silentLogger } from '../src/index.ts'
import { memoryLogger, meta, sleep } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class FakeProcess extends EventEmitter implements ProcessLike {
  exitCode: number | string | null | undefined = undefined
  readonly exits: (number | undefined)[] = []

  exit(code?: number): void {
    this.exits.push(code)
  }

  send(signal: string): void {
    this.emit(signal, signal)
  }
}

function create(
  proc: FakeProcess,
  extra: Partial<ApplicationOptions> = {},
  shutdown: ApplicationOptions['shutdown'] = {},
): Promise<Application> {
  return Application.create({
    metadata: meta({}),
    logger: silentLogger,
    ...extra,
    shutdown: { process: proc, ...shutdown },
  })
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await sleep(2)
}

describe('signal handling', () => {
  it('listens to SIGINT and SIGTERM while running and removes the listeners on stop', async () => {
    const proc = new FakeProcess()
    const app = await create(proc)
    expect(proc.listenerCount('SIGINT')).toBe(0)
    await app.start()
    expect(proc.listenerCount('SIGINT')).toBe(1)
    expect(proc.listenerCount('SIGTERM')).toBe(1)
    await app.stop()
    expect(proc.listenerCount('SIGINT')).toBe(0)
    expect(proc.listenerCount('SIGTERM')).toBe(0)
    expect(proc.exitCode).toBeUndefined()
  })

  it('stops gracefully on a signal without touching exitCode on success', async () => {
    const proc = new FakeProcess()
    const logger = memoryLogger()
    const app = await create(proc, { logger })
    await app.start()
    proc.send('SIGTERM')
    await until(() => app.state === 'stopped')
    expect(app.state).toBe('stopped')
    expect(proc.exitCode).toBeUndefined()
    expect(proc.exits).toEqual([])
    expect(logger.entries.map(entry => entry.message)).toContain('Received SIGTERM: shutting down gracefully')
    expect(proc.listenerCount('SIGTERM')).toBe(0)
  })

  it('sets exitCode to 1 when the signal-triggered shutdown fails', async () => {
    const proc = new FakeProcess()
    const logger = memoryLogger()
    const failing: Plugin = {
      name: 'failing',
      onStop() {
        throw new Error('cannot drain')
      },
    }
    const app = await create(proc, { logger, plugins: [failing] })
    await app.start()
    proc.send('SIGINT')
    await until(() => proc.exitCode !== undefined)
    expect(proc.exitCode).toBe(1)
    expect(logger.entries.some(entry => entry.level === 'error')).toBe(true)
  })

  it('never sets exitCode when stop() is called explicitly', async () => {
    const proc = new FakeProcess()
    const failing: Plugin = {
      name: 'failing',
      onStop() {
        throw new Error('cannot drain')
      },
    }
    const app = await create(proc, { plugins: [failing] })
    await app.start()
    await app.stop().catch(() => undefined)
    expect(proc.exitCode).toBeUndefined()
  })

  it('forces exit(130) on a second signal while stopping', async () => {
    const proc = new FakeProcess()
    const slow: Plugin = { name: 'slow', onStop: () => sleep(50) }
    const app = await create(proc, { plugins: [slow] })
    await app.start()
    proc.send('SIGINT')
    await sleep(5)
    expect(app.state).toBe('stopping')
    proc.send('SIGINT')
    expect(proc.exits).toEqual([130])
    await until(() => app.state === 'stopped')
  })

  it('can listen to custom signals or be disabled', async () => {
    const custom = new FakeProcess()
    const app = await create(custom, {}, { signals: ['SIGHUP'] })
    await app.start()
    expect(custom.listenerCount('SIGHUP')).toBe(1)
    expect(custom.listenerCount('SIGINT')).toBe(0)
    await app.stop()

    const disabled = new FakeProcess()
    const quiet = await create(disabled, {}, { signals: false })
    await quiet.start()
    expect(disabled.eventNames()).toEqual([])
    await quiet.stop()
  })

  it('removes the listeners when start fails', async () => {
    const proc = new FakeProcess()
    const broken: Plugin = {
      name: 'broken',
      onStart() {
        throw new Error('port in use')
      },
    }
    const app = await create(proc, { plugins: [broken] })
    await app.start().catch(() => undefined)
    expect(app.state).toBe('failed')
    expect(proc.listenerCount('SIGTERM')).toBe(0)
  })

  it('stops after the start completes when a signal arrives while starting', async () => {
    const proc = new FakeProcess()
    const log: string[] = []
    const slow: Plugin = {
      name: 'slow',
      onStart: async () => {
        await sleep(20)
        log.push('started')
      },
      onStop: () => {
        log.push('stopped')
      },
    }
    const app = await create(proc, { plugins: [slow] })
    const start = app.start()
    await sleep(2)
    proc.send('SIGTERM')
    await start
    await until(() => app.state === 'stopped')
    expect(log).toEqual(['started', 'stopped'])
  })
})
