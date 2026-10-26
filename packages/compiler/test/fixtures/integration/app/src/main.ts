import { Application } from '@znight/core'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { GreetingService } from './greeting.service.ts'

const app = await Application.create({ metadata: __ZNIGHT_METADATA__, shutdown: { signals: false } })
await app.start()
const greeter = app.container.get(GreetingService)
const report = {
  greeting: greeter.greet('Ada'),
  providers: Object.keys(__ZNIGHT_METADATA__.providers).sort(),
}
console.log(JSON.stringify(report))
await app.stop()
if (process.argv.includes('--fail')) {
  greeter.fail()
}
