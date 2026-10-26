import { Injectable, Primary } from '@znight/core'
import { type Clock, IdGenerator } from '@znight-examples/shared'

/**
 * Time-ordered UUIDs (version 7, RFC 9562): sorting users by id sorts them by creation date, which
 * the cursor pagination of `GET /users` relies on (and which keeps database indexes compact).
 *
 * **Overrides a provider of the shared library.** `@znight-examples/shared` provides
 * `RandomIdGenerator`, another `IdGenerator`. With two candidates for `IdGenerator`, the compiler
 * binds every injection point to the `@Primary()` one — including the constructor of
 * `UserDirectory`, which lives in the library: binding happens at build time over the whole
 * application. Remove `@Primary()` and the build fails with ZNIGHT008 (ambiguous injection).
 *
 * The notifications-worker declares no IdGenerator: it keeps the library default.
 */
@Primary()
@Injectable()
export class SortableIdGenerator extends IdGenerator {
  #lastMs = 0
  #sequence = 0

  // `Clock` is an interface of the shared library: bound to its SystemClock
  constructor(private readonly clock: Clock) {
    super()
  }

  next(): string {
    let ms = this.clock.now().getTime()
    if (ms > this.#lastMs) {
      this.#sequence = 0
    } else {
      // same millisecond (or a clock going backwards): a 12-bit counter keeps the ids increasing
      ms = this.#lastMs
      this.#sequence += 1
      if (this.#sequence > 0xfff) {
        ms += 1
        this.#sequence = 0
      }
    }
    this.#lastMs = ms

    const bytes = crypto.getRandomValues(new Uint8Array(16))
    for (let index = 0; index < 6; index++) {
      bytes[index] = Math.floor(ms / 2 ** (8 * (5 - index))) & 0xff // 48-bit big-endian timestamp
    }
    bytes[6] = 0x70 | (this.#sequence >> 8) // version 7
    bytes[7] = this.#sequence & 0xff
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f) // RFC 9562 variant
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}
