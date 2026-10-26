import { ConfigPlugin } from '@znight/config'
import { Application } from '@znight/core'
import { MessagingPlugin } from '@znight/messaging'
import { memory } from '@znight/messaging/memory'
import { ObservabilityPlugin } from '@znight/observability'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

// __ZNIGHT_METADATA__ was generated at build time from this service AND from the sources of
// @znight-examples/shared (a source provider library): UserDirectory, SystemClock,
// RandomIdGenerator and the event schemas are imported from '@znight-examples/shared'.
const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    // first, so that its hooks wrap everything: one log line and one span per message.
    // Metrics need the optional prom-client peer: add it to the dependencies and drop `metrics: false`.
    ObservabilityPlugin.configure({ logging: { name: 'notifications-worker' }, metrics: false }),
    // loads .env files and the environment, validates WorkerConfig before anything starts
    ConfigPlugin.configure(),
    // in-memory broker: events come from StdinEventSource (WORKER_STDIN_EVENTS=true) or from tests.
    // In production use rabbitmq(), sqs() or kafka() from @znight/messaging/<driver> (and its client).
    MessagingPlugin.configure({ driver: memory() }),
  ],
})

// SIGINT / SIGTERM stop the application gracefully: consumers stop receiving and finish the
// messages in flight, then the providers' onStop hooks run (Heartbeat logs a summary).
await app.start()
