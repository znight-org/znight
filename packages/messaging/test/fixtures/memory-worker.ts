/**
 * A worker whose only ingress is a memory-driver consumer (`test/plugin.keepalive.test.ts`): it must
 * stay alive after `app.start()` until a signal stops it gracefully. Prints its lifecycle on stdout.
 */
import type { Plugin } from '@znight/core'

import { Application } from '@znight/core'

import { memory } from '../../src/drivers/memory.ts'
import { MessagingPlugin } from '../../src/index.ts'
import { handler, messagingMetadata } from '../helpers.ts'

class JobConsumer {
  handle(): void {}
}

const probe: Plugin = {
  name: 'probe',
  onStop() {
    console.log('stopped')
  },
  onDispose() {
    console.log('disposed')
  },
}

const app = await Application.create({
  metadata: messagingMetadata([{ class: JobConsumer, queue: 'jobs', handlers: [handler('handle')] }]),
  plugins: [MessagingPlugin.configure({ driver: memory() }), probe],
  logger: { debug() {}, info() {}, warn() {}, error: (message: string) => console.error(message) },
})
await app.start()
console.log('started')
