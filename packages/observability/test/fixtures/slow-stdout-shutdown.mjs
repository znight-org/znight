// An application logging to stdout (the default console transport) while stdout is slow, then
// stopped by SIGTERM. Every asynchronous write to fd 1 is delayed, as on a loaded CI runner or with a
// slow log collector, so writes are still in flight while the shutdown logs. The parent checks that
// the lines arrive complete and in order.
//
// Usage: bun|node --conditions=@znight/source test/fixtures/slow-stdout-shutdown.mjs ok|fail console|cloudwatch

import fs from 'node:fs'
import { Application } from '@znight/core'

import { cloudwatchTransport, ObservabilityPlugin, ObservabilityTokens as Tokens } from '../../src/index.ts'

const DELAY_MS = 50
const failing = process.argv[2] === 'fail'
// the console transport (default), or the CloudWatch one with asynchronous writes (synchronous by default)
const transport = process.argv[3] === 'cloudwatch' ? cloudwatchTransport({ sync: false }) : undefined

// the destination of pino.destination() (sonic-boom) writes with fs.write(): delay each write to stdout
const write = fs.write
fs.write = function slowWrite(fd, ...args) {
  if (fd !== 1) return write.call(fs, fd, ...args)
  setTimeout(() => write.call(fs, fd, ...args), DELAY_MS)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class Store {
  constructor(logger) {
    this.logger = logger
  }
  onStart() {
    this.logger.info('Store opened')
    // keeps the process alive until the shutdown
    this.timer = setInterval(() => {}, 60_000)
  }
  async onStop() {
    clearInterval(this.timer)
    this.logger.info('Store stopping')
    for (let i = 0; i < 20; i++) {
      this.logger.info('Store saving', { i })
      if (i % 5 === 0) await sleep(1)
    }
    this.logger.info('Store saved')
  }
  async [Symbol.asyncDispose]() {
    await sleep(1)
    this.logger.info('Store closed')
    if (failing) throw new Error('disk full')
  }
}

const token = 'src/store.ts#Store'
const metadata = {
  version: 1,
  providers: {
    [token]: { scope: 'singleton', class: Store, deps: [Tokens.Logger], factory: d => new Store(d[0]) },
  },
  resolutionOrder: [token],
  externals: Object.values(Tokens).map(external => ({ token: external, providedBy: 'ObservabilityPlugin' })),
}

const app = await Application.create({
  metadata,
  plugins: [ObservabilityPlugin.configure({ logging: { level: 'info', base: null, transport }, metrics: false })],
})
await app.start()
process.kill(process.pid, 'SIGTERM')
