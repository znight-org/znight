import { Injectable } from '@znight/core'
import metadata from './.znight/container.generated.ts'

@Injectable()
export class DirectService {
  readonly metadata: unknown = metadata
}
