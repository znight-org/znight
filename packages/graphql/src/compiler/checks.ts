/**
 * Checks shared by the code-first schema builder (`builder.ts`) and the schema-first one
 * (`schema-first.ts`): loader providers (ZNIGHT065) and the route decisions of root fields
 * (ZNIGHT023, RFC 0001).
 */
import type { ClassInfo, Diagnostic, Location, ValidateContext } from '@znight/compiler'
import type { MetaEntry } from '@znight/http/compiler'
import type { GraphQLData, ResolverData } from './data.ts'

import { requiredRouteGroups } from '@znight/http/compiler'

import { ROOT_TYPE_NAMES } from '../names.ts'
import { Codes } from './constants.ts'
import { GraphQLIds } from './ids.ts'

type Context = ValidateContext<GraphQLData>
type Report = (diagnostic: Diagnostic) => void

/** `Loader<L>`: `L` must be a loader provider, implementing `BatchLoad<K, V>` (ZNIGHT065). */
export function checkLoaders(ctx: Context, resolvers: readonly ResolverData[], report: Report): void {
  const seen = new Set<number>()
  for (const resolver of resolvers) {
    for (const field of resolver.fields) {
      for (const param of field.params) {
        if (param?.kind !== 'loader' || seen.has(param.binding.id)) continue
        seen.add(param.binding.id)
        const ref = ctx.binding(param.binding)
        const token = tokenOfRef(ref)
        const provider = token === undefined ? undefined : ctx.provider(token)
        // an unbound loader is ZNIGHT001 (reported by the binding)
        if (provider === undefined || provider.heritage.some(type => type.identity === GraphQLIds.BatchLoad)) continue
        if (provider.kind !== 'class' || hasLoadMethod(ctx, provider.classIdentity)) continue
        report({
          code: Codes.InvalidLoader,
          severity: 'error',
          message: `${provider.displayName} is not a loader: Loader<${provider.displayName}> needs a provider implementing BatchLoad<K, V> (${resolver.host.displayName}.${field.method})`,
          location: param.location,
          hints: [
            `export class ${provider.displayName} implements BatchLoad<ID, Value> { async load(keys: readonly ID[]): Promise<readonly (Value | Error)[]> { ... } }`,
          ],
        })
      }
    }
  }
}

/**
 * RFC 0001: every root field decides every required route decorator group (ZNIGHT023). `roots`
 * names the root types (`schema { query: RootQuery }` in schema-first).
 */
export function checkDecisions(
  ctx: Context,
  resolvers: readonly ResolverData[],
  report: Report,
  roots: { readonly query: string; readonly mutation?: string; readonly subscription?: string } = ROOT_TYPE_NAMES,
): void {
  const applied: MetaEntry[] = []
  for (const resolver of resolvers) for (const field of resolver.fields) applied.push(...field.meta)
  const required = requiredRouteGroups(ctx, applied)
  if (required.length === 0) return
  for (const resolver of resolvers) {
    for (const field of resolver.fields) {
      if (field.operation === 'field') continue
      const decided = new Set(field.meta.map(entry => entry.group))
      for (const group of required) {
        if (decided.has(group.group)) continue
        const root = roots[field.operation] ?? ROOT_TYPE_NAMES[field.operation]
        report({
          code: Codes.MissingRouteDecision,
          severity: 'error',
          message: `Root field ${root}.${field.name} (${resolver.host.displayName}.${field.method}) has no "${group.group}" decision`,
          location: field.methodLocation,
          hints: [`Add ${group.suggestion} to the method or to ${resolver.host.displayName}`],
          related: [
            {
              message: `The "${group.group}" group is required`,
              location: (group.decorators[0] as { definition: Location }).definition,
            },
          ],
        })
      }
    }
  }
}

/** The class (or one of its base classes) declares an instance `load` method. */
function hasLoadMethod(ctx: Context, identity: string): boolean {
  const seen = new Set<string>()
  let current: string | undefined = identity
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const cls: ClassInfo | undefined = ctx.classInfo(current)
    if (cls === undefined) return true // not analysable (a compiled class): trust the type checker
    if (cls.methods.some(method => method.name === 'load' && method.kind === 'method' && !method.static)) return true
    if (cls.properties.some(property => property.name === 'load' && !property.static)) return true
    current = cls.superClass?.identity
  }
  return false
}

/** The token of a binding result (`undefined` when binding failed). */
function tokenOfRef(ref: ReturnType<Context['binding']>): string | undefined {
  if (typeof ref === 'string') return ref
  return ref !== undefined && 'token' in ref ? ref.token : undefined
}
