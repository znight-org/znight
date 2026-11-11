import { Injectable } from '@znight/core'
import type { metadata } from './.znight/container.generated.js'

@Injectable()
export class TypedService {
  readonly metadata?: typeof metadata
}
