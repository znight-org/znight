import { Injectable } from '@znight/core'

@Injectable()
export class Clock {
  now(): number {
    return Date.now()
  }
}
