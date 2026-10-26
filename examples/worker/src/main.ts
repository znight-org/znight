import { ConfigPlugin } from '@znight/config'
import { Application } from '@znight/core'
import { MessagingPlugin } from '@znight/messaging'
import { ObservabilityPlugin } from '@znight/observability'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { createDriver } from './messaging/driver.js'
import { KeepAlivePlugin } from './messaging/keep-alive.plugin.js'
import { StdinInboxPlugin } from './messaging/stdin-inbox.plugin.js'
import { WorkerConfig } from './worker.config.js'

// A background worker: no HTTP server, only message consumers. The DI container was generated at
// build time from the decorators (src/.znight/container.generated.ts): there is nothing to register.
const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    // first, so that its hooks wrap everything: one structured log line per message (JSON on stdout),
    // a consumer span per message (with an OpenTelemetry SDK registered)
    ObservabilityPlugin.configure(container => ({
      logging: { level: container.get(WorkerConfig).logLevel },
      // no Prometheus metrics: add `prom-client` and remove this line to expose :9464/metrics
      metrics: false,
    })),
    // loads .env files and the environment, validates every @Config class before anything starts
    ConfigPlugin.configure(),
    // consumers subscribe on start; options computed from the container, once the config is loaded
    MessagingPlugin.configure(container => ({
      driver: createDriver(container.get(WorkerConfig)),
      // policy of the handlers without @Retry (every handler here has its own)
      defaults: { retry: { attempts: 3, backoff: 'exponential', delay: 500, maxDelay: 10_000 } },
    })),
    // after MessagingPlugin: started once the consumers subscribed, stopped before they drain
    StdinInboxPlugin.configure(container => ({ enabled: container.get(WorkerConfig).stdinInbox })),
    // workaround: the memory driver holds no connection open, keep the process alive until stopped
    KeepAlivePlugin.configure(container => ({ enabled: container.get(WorkerConfig).rabbitmqUrl === undefined })),
  ],
  shutdown: {
    // a stop step (draining the consumers is one) may take up to 15 s: in-flight reports finish
    hookTimeoutMs: 15_000,
    // the whole shutdown (drain, disposal of the SMTP client, log flush) must end within 30 s
    timeoutMs: 30_000,
  },
})

// Graceful shutdown on SIGINT / SIGTERM (a second signal forces the exit):
// stdin inbox stops reading → consumers stop receiving and finish their in-flight messages →
// providers are disposed (SMTP connection closed) → driver connection closed → logs flushed.
await app.start()
