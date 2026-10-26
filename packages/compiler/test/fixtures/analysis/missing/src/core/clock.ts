import { Injectable } from '@znight/core'

export interface Clock {
  now(): number
}

@Injectable({ name: 'system' })
export class SystemClock implements Clock {
  now(): number {
    return 0
  }
}

export class Mailer {}
