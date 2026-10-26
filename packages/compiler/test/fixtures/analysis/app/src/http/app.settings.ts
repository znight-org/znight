import { Settings, Value } from '@znight/fake-http'

@Settings()
export class AppSettings {
  @Value('APP_NAME')
  name = 'znight'

  @Value('APP_DEBUG')
  debug?: boolean
}
