import { Factory, Inject, Provides } from '@znight/core'
import { events } from '../events.js'
import { Database } from './database.js'

export interface Settings {
  readonly url: string
}

@Factory()
export class InfraFactory {
  @Provides({ name: 'port' })
  port(): number {
    return 8080
  }

  @Provides()
  settings(@Inject('port') port: number): Settings {
    return { url: `db://localhost:${port}` }
  }

  @Provides({ dispose: 'close' })
  async database(settings: Settings): Promise<Database> {
    await Promise.resolve()
    events.push('Database.open')
    return new Database(settings.url)
  }
}
