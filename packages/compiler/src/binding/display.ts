/**
 * Rendering helpers for binding messages: display names (`Repository<User>`) and `file:line`
 * positions relative to the project root — never raw identities alone (§4.7).
 */
import type { ProviderDraft } from '../analysis/registry.ts'
import type { Location, Project } from '../project/index.ts'

import { relativePath } from '../project/index.ts'

/** `src/users/user.service.ts:12`. */
export function position(project: Project, location: Location): string {
  return `${relativePath(project.root, location.file)}:${location.line}`
}

/** `PgUserRepository (src/users/pg.repository.ts:5)`, with its qualifier when it has one. */
export function describeProvider(project: Project, draft: ProviderDraft): string {
  const named = draft.name === undefined ? '' : ` named '${draft.name}'`
  return `${draft.displayName}${named} (${position(project, draft.location)})`
}

/** Comma-separated list of providers. */
export function describeProviders(project: Project, drafts: readonly ProviderDraft[]): string {
  return drafts.map(draft => describeProvider(project, draft)).join(', ')
}

/** Location of the declaration named by an identity, when it can be found. */
export function declarationLocation(project: Project, identity: string): Location | undefined {
  const symbol = project.lookupIdentity(identity)
  if (symbol.kind !== 'declaration') {
    return undefined
  }
  return project.getFile(symbol.declaration.file)?.location(symbol.declaration.span)
}
