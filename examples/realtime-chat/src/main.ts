import { createApplication } from './.znight/container.generated.js'
import { plugins } from './plugins.js'

const app = await createApplication({ plugins: plugins() })
await app.start() // SIGTERM: handshakes refused, sockets closed with 1001, @OnDisconnect run, HTTP drained
