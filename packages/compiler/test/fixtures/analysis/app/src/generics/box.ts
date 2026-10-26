import { Injectable } from '@znight/core'
import type { Clock } from '../core/clock.ts'

export class Box<T> {
  constructor(readonly value: T) {}
}

export class Holder<A, B = A> extends Box<B> {}

@Injectable()
export class ClockBox extends Holder<string, Clock> {}
