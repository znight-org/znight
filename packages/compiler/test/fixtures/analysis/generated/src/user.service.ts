import { Injectable } from '@znight/core'
import { helper } from './helper.ts'

@Injectable()
export class UserService {
  readonly value: unknown = helper
}
