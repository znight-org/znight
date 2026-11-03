import type { CurrentUser } from './current-user.js'
import type { Viewer } from './viewer.js'

import { Query, Resolver } from '@znight/graphql'

import { Authenticated } from './access.js'

/**
 * A request-scoped resolver: one instance per operation (per HTTP request), so it injects the
 * request-scoped `CurrentUser` directly, without `Lazy`. A singleton is cheaper: prefer it unless the
 * resolver holds per-request state.
 */
@Resolver({ scope: 'request' })
export class ViewerResolver {
  constructor(private readonly user: CurrentUser) {}

  /** The caller of the request. */
  @Query()
  @Authenticated()
  me(): Viewer {
    const { name, email, roles } = this.user.principal
    return { name, email, roles }
  }
}
