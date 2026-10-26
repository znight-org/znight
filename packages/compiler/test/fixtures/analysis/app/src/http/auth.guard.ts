import type { Clock } from '../core/clock.ts'

export class AuthGuard {
  constructor(readonly clock: Clock) {}
}
