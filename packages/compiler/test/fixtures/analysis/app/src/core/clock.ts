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

@Injectable({ name: 'fake' })
export class FakeClock implements Clock {
  now(): number {
    return 0
  }
}

@Injectable()
@Named('frozen')
export class FrozenClock extends FakeClock {}
