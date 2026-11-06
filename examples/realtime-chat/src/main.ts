import { Application } from '@znight/core'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { plugins } from './plugins.js'

const app = await Application.create({ metadata: __ZNIGHT_METADATA__, plugins: plugins() })
await app.start() // SIGTERM: handshakes refused, sockets closed with 1001, @OnDisconnect run, HTTP drained
