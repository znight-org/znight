import { Factory, Named, Provides } from '@znight/core'

export const DEFAULT_PORT = 3000
export const PORT = 'port'

export interface AppConfig {
  readonly url: string
}

@Factory()
export class ConfigFactory {
  @Provides({ name: PORT })
  port(): number {
    return DEFAULT_PORT
  }

  @Provides()
  @Named('apiUrl')
  apiUrl(): string {
    return 'http://localhost'
  }

  @Provides()
  config(): AppConfig {
    return { url: 'postgres://localhost' }
  }
}
