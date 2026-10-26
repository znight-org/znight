import { Injectable, type TypedToken, token } from '@znight/core'

/**
 * The current time. Services depend on this interface rather than on `new Date()`, so that tests
 * (and applications) can swap the implementation without touching the code reading the time.
 *
 * An interface has no runtime value: the compiler resolves `clock: Clock` at build time to the
 * single provider implementing it (or to the `@Primary()` one when there are several).
 */
export interface Clock {
  now(): Date
}

/**
 * Runtime key of {@link Clock}, for the places that need a value: `app.get(CLOCK)`, test
 * `overrides: [[CLOCK, fixedClock]]`. The compiler records an alias under the identity of the
 * interface (`<package>#<export>`) when one provider implements it.
 */
export const CLOCK: TypedToken<Clock> = token<Clock>('@znight-examples/shared#Clock')

/** The wall clock: the {@link Clock} of every service using this library, unless it brings its own. */
@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
}
