import type { ZnightMetadata } from '@znight/core'

import { ADAPTERS, controller, createApp, metadata, provider, route, sleep, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class SlowController {
  readonly gate: { started: () => void; wait: Promise<void> }
  constructor(gate: { started: () => void; wait: Promise<void> }) {
    this.gate = gate
  }
  async slow() {
    this.gate.started()
    await this.gate.wait
    return 'done'
  }
}

interface Gate {
  readonly meta: ZnightMetadata
  readonly started: Promise<void>
  release(): void
}

function gate(): Gate {
  let release!: () => void
  let started!: () => void
  const wait = new Promise<void>(resolve => {
    release = resolve
  })
  const startedPromise = new Promise<void>(resolve => {
    started = resolve
  })
  const value = { started, wait }
  const meta = metadata(
    { [t('SlowController')]: { ...provider(SlowController), deps: [], factory: () => new SlowController(value) } },
    [controller(t('SlowController'), '/', [route('slow', '/slow', (c: SlowController) => c.slow())])],
  )
  return { meta, started: startedPromise, release }
}

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} adapter lifecycle`, () => {
    it('drains in-flight requests on stop and refuses new connections', async () => {
      const { meta, started, release } = gate()
      const app = await createApp(meta, { adapter: adapter.create(), drainTimeoutMs: 5_000 })
      const url = String(app.http.address)
      const pending = fetch(`${url}/slow`)
      await started
      expect(app.http.inflight).toBe(1)
      const stopping = app.stop()
      await sleep(50)
      expect(app.app.state).toBe('stopping')
      const refused = await fetch(`${url}/slow`).then(
        () => 'connected',
        () => 'refused',
      )
      expect(refused).toBe('refused')
      release()
      const response = await pending
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('done')
      await stopping
      expect(app.app.state).toBe('stopped')
      expect(app.http.address).toBeUndefined()
      expect(app.http.inflight).toBe(0)
    })

    it('closes the remaining connections after drainTimeoutMs', async () => {
      const { meta, started, release } = gate()
      const app = await createApp(meta, { adapter: adapter.create(), drainTimeoutMs: 100 })
      const pending = fetch(`${String(app.http.address)}/slow`).then(
        response => response.text(),
        () => 'aborted',
      )
      await started
      const startedAt = performance.now()
      await app.stop()
      expect(performance.now() - startedAt).toBeLessThan(2_000)
      expect(await pending).toBe('aborted')
      expect(
        app.logger.entries.some(entry => entry.message.includes('closing 1 in-flight request(s) after 100 ms')),
      ).toBe(true)
      release()
    })

    it('waits for in-flight requests with a drainTimeoutMs beyond the setTimeout range', async () => {
      for (const drainTimeoutMs of [Number.POSITIVE_INFINITY, 3e9]) {
        const { meta, started, release } = gate()
        const app = await createApp(meta, { adapter: adapter.create(), drainTimeoutMs })
        const pending = fetch(`${String(app.http.address)}/slow`).then(
          response => response.text(),
          () => 'aborted',
        )
        await started
        const stopping = app.stop()
        // setTimeout(fn, Infinity) used to fire after 1 ms and close the connection at once
        await sleep(200)
        expect({ drainTimeoutMs, state: app.app.state }).toEqual({ drainTimeoutMs, state: 'stopping' })
        release()
        expect(await pending).toBe('done')
        await stopping
        expect(app.logger.entries.some(entry => entry.message.includes('in-flight request(s) after'))).toBe(false)
      }
    })

    it('can stop an application that never listened', async () => {
      const { meta } = gate()
      const app = await createApp(meta, { adapter: adapter.create() }, { start: false })
      await app.stop()
      expect(app.app.state).toBe('stopped')
    })

    it('logs the listening address', async () => {
      const { meta } = gate()
      const app = await createApp(meta, { adapter: adapter.create() })
      const entry = app.logger.entries.find(e => e.message.startsWith('HTTP server listening on'))
      expect(entry?.message).toBe(`HTTP server listening on ${String(app.http.address)}`)
      expect(entry?.context).toEqual({ adapter: adapter.name, routes: 2 })
      await app.stop()
    })
  })
}
