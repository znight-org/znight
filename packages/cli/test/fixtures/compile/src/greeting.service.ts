import { Injectable } from '@znight/core'

import { Clock } from './clock.ts'

@Injectable()
export class GreetingService {
  constructor(private readonly clock: Clock) {}

  greet(name: string): string {
    return `Hello ${name} at ${this.clock.now()}`
  }
}
