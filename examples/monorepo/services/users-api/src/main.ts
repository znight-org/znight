import { ConfigPlugin } from '@znight/config'
import { Application } from '@znight/core'
import { ObservabilityPlugin } from '@znight/observability'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { usersHttpPlugin } from './http.js'

// __ZNIGHT_METADATA__ was generated at build time from this service AND from the sources of
// @znight-examples/shared (a source provider library): UserDirectory, SystemClock... are in it,
// imported from '@znight-examples/shared'.
const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    // first, so that its hooks wrap everything: JSON logs (one per request), traces.
    // Metrics need the optional prom-client peer: add it to the dependencies and drop `metrics: false`.
    ObservabilityPlugin.configure({ logging: { name: 'users-api' }, metrics: false }),
    // loads .env files and the environment, validates ApiConfig before anything starts
    ConfigPlugin.configure(),
    usersHttpPlugin(),
  ],
})

// SIGINT / SIGTERM stop the application gracefully: the HTTP server drains its in-flight requests,
// then UserSnapshot.onStop() saves the users, and the process exits with code 0.
await app.start()
