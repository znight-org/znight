import type { EmailAddress } from '../shared/scalars.js'
import type { Role } from './access.js'

/** Who is calling: the client of an API key. */
export interface Principal {
  readonly name: string
  readonly email: EmailAddress
  readonly roles: readonly Role[]
}
