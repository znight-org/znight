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

/** Collides with the `Application` import of the generated module (imported as `Application$1`). */
@Injectable()
export class Application {
  readonly kind = 'user-application'
}

/** Collides with the names exported by the generated module (reserved: imported as `metadata$1`...). */
@Injectable()
export class metadata {
  readonly kind = 'user-metadata-export'
}

@Injectable()
export class createApplication {
  readonly kind = 'user-create-application'
}
