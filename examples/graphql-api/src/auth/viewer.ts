import type { EmailAddress } from '../shared/scalars.js'
import type { Role } from './access.js'

/** The caller, as the API sees them. */
export interface Viewer {
  readonly name: string
  readonly email: EmailAddress
  readonly roles: readonly Role[]
}
