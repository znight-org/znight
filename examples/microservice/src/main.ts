import { ConfigPlugin } from '@znight/config'
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'
import { MessagingPlugin } from '@znight/messaging'
import { ObservabilityPlugin } from '@znight/observability'

// the dependency injection container, generated at build time by @znight/compiler
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { HttpConfig } from './config/http.config.js'
import { MessagingConfig } from './config/messaging.config.js'
import { ObservabilityConfig } from './config/observability.config.js'
import { messagingOptions } from './messaging/messaging.options.js'
import { observabilityOptions } from './observability/observability.options.js'
import { startTracing } from './observability/tracing.js'

// OpenTelemetry first: the context manager must exist before the first span
const tracing = startTracing()

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    tracing.plugin,
    // before the feature plugins, so that its hooks wrap everything: logs, metrics and spans of
    // every request and message
    ObservabilityPlugin.configure(container => observabilityOptions(container.get(ObservabilityConfig), tracing)),
    // loads .env files and the environment, then validates every @Config class at once
    ConfigPlugin.configure(),
    // the options are functions of the container: they read the (validated) config classes
    MessagingPlugin.configure(container => messagingOptions(container.get(MessagingConfig))),
    HttpPlugin.configure(container => {
      const http = container.get(HttpConfig)
      return { adapter: honoAdapter(), port: http.port, host: http.host, exposeErrors: http.exposeErrors }
    }),
  ],
  shutdown: {
    // a deadline for the whole shutdown; each step (HTTP drain, consumers drain...) gets hookTimeoutMs
    timeoutMs: 15_000,
    hookTimeoutMs: 8_000,
  },
})

// SIGINT / SIGTERM stop the service gracefully: the HTTP server stops accepting connections and
// drains the requests in flight, the consumers stop receiving and finish the messages in progress,
// then the providers are disposed and the connections closed (exit code 0, or 1 if a step failed).
await app.start()
