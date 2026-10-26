import { Injectable } from '@znight/core'

/** Shadows the global `Date` in this module only. */
@Injectable()
export class Date {
  readonly kind = 'user-date'
}

@Injectable()
export class URL {
  readonly kind = 'user-url'
}

@Injectable()
export class ZnightMetadata {
  readonly kind = 'user-metadata'
}
