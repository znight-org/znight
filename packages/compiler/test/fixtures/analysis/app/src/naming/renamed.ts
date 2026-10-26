import * as zn from '@znight/core'
import { Service } from './index.ts'

@zn.Injectable()
export class NamespacedService {}

@Service({ scope: 'transient' })
export class BarrelService {
  constructor(readonly namespaced: NamespacedService) {}
}
