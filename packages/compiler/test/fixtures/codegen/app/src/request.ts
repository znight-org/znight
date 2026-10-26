import type { RequestId } from '@fixture/logging'
import { Injectable, type Lazy } from '@znight/core'

@Injectable({ scope: 'request' })
export class RequestState {
  readonly requestId: RequestId

  constructor(requestId: RequestId) {
    this.requestId = requestId
  }
}

let created = 0

@Injectable({ scope: 'transient' })
export class Counter {
  readonly index: number = ++created
}

@Injectable()
export class Reporter {
  readonly first: Counter
  readonly second: Counter
  readonly state: Lazy<RequestState>

  constructor(first: Counter, second: Counter, state: Lazy<RequestState>) {
    this.first = first
    this.second = second
    this.state = state
  }
}
