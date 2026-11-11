import { createApplication, metadata } from './.znight/container.generated.js'
import { GreetingService } from './greeting.service.ts'

const app = await createApplication({ shutdown: { signals: false } })
await app.start()
const greeter = app.container.get(GreetingService)
const report = {
  greeting: greeter.greet('Ada'),
  providers: Object.keys(metadata.providers).sort(),
}
console.log(JSON.stringify(report))
await app.stop()
if (process.argv.includes('--fail')) {
  greeter.fail()
}
