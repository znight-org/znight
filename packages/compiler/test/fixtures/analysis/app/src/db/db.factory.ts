import { Factory, Inject, Primary, Provides } from '@znight/core'
import { Pool } from 'pg-lite'
import type { AppConfig } from '../core/config.ts'

@Factory()
export class DbFactory {
  constructor(@Inject('port') readonly port: number) {}

  @Provides({ dispose: 'end' })
  @Primary()
  async createPool(config: AppConfig): Promise<Pool> {
    return new Pool({ url: config.url })
  }

  @Provides({ name: 'replica', scope: 'transient' })
  replica(@Inject('apiUrl') url: string): Pool {
    return new Pool({ url })
  }
}
