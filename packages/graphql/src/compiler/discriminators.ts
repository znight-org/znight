/**
 * Union discriminators (RFC 0005 §5.7): how the runtime tells the members of a union apart, decided
 * at build time so that `resolveType` is a lookup.
 */
import type { ClassInfo } from '@znight/compiler'
import type { DiscriminatorModel, ObjectModel } from './model.ts'

import { compareStrings } from './constants.ts'

/**
 * `instanceof` when every member is an exported class (subclasses first), `__typename` when every
 * member declares it, else the first property of the first member whose literal value differs in
 * every member; `undefined` when none applies (ZNIGHT064).
 */
export function discriminatorOf(
  members: readonly ObjectModel[],
  classInfo: (identity: string) => ClassInfo | undefined,
): DiscriminatorModel | undefined {
  if (members.every(member => member.classIdentity !== undefined && classInfo(member.classIdentity)?.exported)) {
    const depth = (identity: string): number => classInfo(identity)?.heritage.length ?? 0
    return {
      by: 'class',
      classes: members
        .map(member => ({ identity: member.classIdentity as string, name: member.name }))
        // subclasses first: `instanceof` of a base class also matches its subclasses
        .sort((a, b) => depth(b.identity) - depth(a.identity) || compareStrings(a.name, b.name)),
    }
  }
  if (members.every(member => member.properties.some(property => property.name === '__typename'))) {
    return { by: 'typename' }
  }
  for (const candidate of members[0]?.properties ?? []) {
    if (candidate.optional || candidate.literal === undefined) continue
    const values = literalValues(members, candidate.name)
    if (values !== undefined) return { by: 'property', property: candidate.name, values }
  }
  return undefined
}

/** Literal value → member name when `property` is a required literal with a distinct value in every member. */
function literalValues(members: readonly ObjectModel[], property: string): Record<string, string> | undefined {
  const values = new Map<string, string>()
  for (const member of members) {
    const found = member.properties.find(entry => entry.name === property)
    if (found === undefined || found.optional || found.literal === undefined) return undefined
    const key = String(found.literal)
    if (values.has(key)) return undefined
    values.set(key, member.name)
  }
  const sorted: Record<string, string> = {}
  for (const key of [...values.keys()].sort(compareStrings)) sorted[key] = values.get(key) as string
  return sorted
}
