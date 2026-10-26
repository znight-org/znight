import { Inject, Injectable } from '@znight/core'

import { Clock } from './clock.ts'

@Injectable()
export class GreetingService {
  constructor(
    private readonly clock: Clock,
    @Inject('prefix') private readonly prefix: string,
  ) {}

  greet(name: string): string {
    return `${this.prefix} ${name} @${this.clock.now()}`
  }

  fail(): never {
    throw new Error('boom from GreetingService')
  }
}
