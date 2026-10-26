import { Injectable, Named, Primary } from '@znight/core'

export interface Clock {
  now(): number
}

@Injectable()
@Primary()
export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}

@Injectable()
@Named('fixed')
export class FixedClock implements Clock {
  now(): number {
    return 42
  }
}
