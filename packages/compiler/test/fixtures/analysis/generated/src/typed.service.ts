import { Injectable } from '@znight/core'
import type { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

@Injectable()
export class TypedService {
  readonly metadata?: typeof __ZNIGHT_METADATA__
}
