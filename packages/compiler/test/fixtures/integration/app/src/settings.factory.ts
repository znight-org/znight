import { Factory, Provides } from '@znight/core'

@Factory()
export class SettingsFactory {
  readonly base = 'Hello'

  @Provides({ name: 'prefix' })
  prefix(): string {
    return this.base
  }
}
