import { Settings, Value } from '@fixture/web'

@Settings()
export class AppSettings {
  @Value('APP_NAME')
  name = 'default-name'

  @Value('APP_PORT')
  port = 0
}
