/**
 * `validate` of the `@znight/http` compiler extension: route paths (grammar of `@znight/http/path`),
 * `:param` ↔ `@Param` consistency and duplicate routes across every controller (ZNIGHT007); route
 * decorator groups: consistent definitions (ZNIGHT005) and a decision of every required group on
 * every route (ZNIGHT023).
 */
import type { Location, ValidateContext } from '@znight/compiler'
import type { RoutePath } from '../path.ts'
import type { HttpControllerData, HttpRouteData, MetaEntry } from './model.ts'

import { checkRoutePath, compareStrings, parseRoutePath, WILDCARD_PARAM } from '../path.ts'
import { Codes, Ids } from './model.ts'
import { parseRouteDecoratorOptions } from './route-decorators.ts'

type Context = ValidateContext<HttpControllerData>

interface RegisteredRoute {
  readonly where: string
  readonly route: HttpRouteData
}

/** Validates the routes of every controller. */
export function validateHttp(ctx: Context): void {
  const controllers = [...ctx.stored].sort((a, b) => compareStrings(a.token, b.token))
  const registered = new Map<string, RegisteredRoute>()
  for (const controller of controllers) {
    const baseIssue = checkRoutePath(controller.rawBasePath)
    if (baseIssue !== undefined) {
      invalidRoute(
        ctx,
        controller.pathLocation,
        `Invalid base path ${JSON.stringify(controller.rawBasePath)} of ${controller.displayName}: ${baseIssue.message}`,
        GRAMMAR_HINTS,
      )
      continue
    }
    for (const route of controller.routes) {
      const where = `${controller.displayName}.${route.handler}`
      const ownIssue = checkRoutePath(route.rawPath)
      const issue = ownIssue ?? checkRoutePath(route.fullPath)
      if (issue !== undefined) {
        const path = ownIssue === undefined ? route.fullPath : route.rawPath
        invalidRoute(
          ctx,
          route.pathLocation,
          `Invalid route path ${JSON.stringify(path)} of ${where}: ${issue.message}`,
          GRAMMAR_HINTS,
        )
        continue
      }
      const parsed = parseRoutePath(route.fullPath)
      checkParams(ctx, route, parsed, where)
      const key = `${route.method} ${parsed.shape}`
      const previous = registered.get(key)
      if (previous === undefined) {
        registered.set(key, { where, route })
        continue
      }
      ctx.report({
        code: Codes.InvalidRoute,
        severity: 'error',
        message: `Duplicate route ${route.method} ${route.fullPath}: ${where} conflicts with ${previous.where} (${previous.route.method} ${previous.route.fullPath})`,
        location: route.location,
        hints: ['Two routes with the same method and the same path shape (parameter names aside) cannot coexist'],
        related: [{ message: `${previous.where} is declared here`, location: previous.route.location }],
      })
    }
  }
  validateDecisions(ctx, controllers)
}

/** A route decorator definition seen during the compile (applied, or found by `definitionsOf`). */
interface Definition {
  readonly identity: string
  readonly name: string
  readonly key: string
  readonly group: string
  readonly required: boolean
  readonly definition: Location
  /** A flag (`@Public()`): no type argument, or every usage without argument. */
  flag: boolean
}

/**
 * Every route decorator definition, sorted by identity: the applied ones (first usage) and, when
 * the compiler provides `definitionsOf`, the ones applied nowhere (invalid ones are left to the
 * usages, which report them).
 */
function routeDecoratorDefinitions(ctx: Context, controllers: readonly HttpControllerData[]): Definition[] {
  const definitions = new Map<string, Definition>()
  const visit = (entries: readonly MetaEntry[]): void => {
    for (const entry of entries) {
      const known = definitions.get(entry.identity)
      if (known === undefined) {
        definitions.set(entry.identity, {
          identity: entry.identity,
          name: entry.decorator,
          key: entry.key,
          group: entry.group,
          required: entry.required,
          definition: entry.definition,
          flag: entry.value === true,
        })
      } else if (entry.value !== true) {
        known.flag = false
      }
    }
  }
  for (const controller of controllers) {
    visit(controller.meta)
    for (const route of controller.routes) visit(route.meta)
  }
  // compilers before RFC 0001 have no definitionsOf: only applied decorators are known then
  const all = typeof ctx.definitionsOf === 'function' ? ctx.definitionsOf(Ids.createRouteDecorator) : []
  for (const found of all) {
    const [keyArg, optionsArg, ...extra] = found.args
    const key = keyArg?.evaluated === true ? keyArg.value : undefined
    if (
      typeof key !== 'string' ||
      key === '' ||
      extra.length > 0 ||
      (optionsArg !== undefined && !optionsArg.evaluated)
    ) {
      continue
    }
    const parsed = parseRouteDecoratorOptions(key, optionsArg?.value)
    if ('error' in parsed) {
      continue
    }
    const flag = found.typeArgs.length === 0
    const known = definitions.get(found.identity)
    if (known !== undefined) {
      known.flag &&= flag
      continue
    }
    definitions.set(found.identity, {
      identity: found.identity,
      name: found.name,
      key,
      ...parsed,
      definition: found.location,
      flag,
    })
  }
  return [...definitions.values()].sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * Route decorator groups (RFC 0001 §5.1): every definition of a key uses the same options and the
 * decorators of a group agree on `required` (ZNIGHT005, at the second definition); every route has
 * a decision of every required group, its own or its controller's (ZNIGHT023).
 */
function validateDecisions(ctx: Context, controllers: readonly HttpControllerData[]): void {
  const definitions = routeDecoratorDefinitions(ctx, controllers)
  if (definitions.length === 0) {
    return
  }
  const byKey = new Map<string, Definition>()
  const byGroup = new Map<string, Definition>()
  const members = new Map<string, Definition[]>()
  for (const definition of definitions) {
    const sameKey = byKey.get(definition.key)
    if (sameKey !== undefined && (sameKey.group !== definition.group || sameKey.required !== definition.required)) {
      ctx.report({
        code: Codes.InvalidDecorator,
        severity: 'error',
        message: `The route decorator ${definition.name} defines the key "${definition.key}" with ${describeOptions(definition)}, but ${sameKey.name} defines it with ${describeOptions(sameKey)}`,
        location: definition.definition,
        hints: ['Every definition of a key must use the same options: share one definition'],
        related: [{ message: `${sameKey.name} is defined here`, location: sameKey.definition }],
      })
      continue
    }
    const sameGroup = byGroup.get(definition.group)
    if (sameGroup !== undefined && sameGroup.required !== definition.required) {
      ctx.report({
        code: Codes.InvalidDecorator,
        severity: 'error',
        message: `The "${definition.group}" group is ${definition.required ? '' : 'not '}required for ${definition.name} but ${sameGroup.required ? '' : 'not '}required for ${sameGroup.name}`,
        location: definition.definition,
        hints: [`All the decorators of the "${definition.group}" group must agree on required`],
        related: [{ message: `${sameGroup.name} is defined here`, location: sameGroup.definition }],
      })
      continue
    }
    byKey.set(definition.key, sameKey ?? definition)
    byGroup.set(definition.group, sameGroup ?? definition)
    const list = members.get(definition.group) ?? []
    list.push(definition)
    members.set(definition.group, list)
  }
  const required = [...byGroup.values()].filter(definition => definition.required)
  if (required.length === 0) {
    return
  }
  for (const controller of controllers) {
    const controllerGroups = new Set(controller.meta.map(entry => entry.group))
    for (const route of controller.routes) {
      const decided = new Set([...controllerGroups, ...route.meta.map(entry => entry.group)])
      for (const group of required) {
        if (decided.has(group.group)) {
          continue
        }
        // the decorators of the group in source order: `@Public(), @Authenticated() or @Roles(...)`
        const inOrder = [...(members.get(group.group) ?? [group])].sort(
          (a, b) => compareStrings(a.definition.file, b.definition.file) || a.definition.start - b.definition.start,
        )
        const decorators = inOrder.map(definition => `@${definition.name}(${definition.flag ? '' : '...'})`)
        const listed =
          decorators.length === 1
            ? (decorators[0] as string)
            : `${decorators.slice(0, -1).join(', ')} or ${decorators.at(-1) as string}`
        ctx.report({
          code: Codes.MissingRouteDecision,
          severity: 'error',
          message: `Route ${route.method} ${route.fullPath} (${controller.displayName}.${route.handler}) has no "${group.group}" decision`,
          location: route.location,
          hints: [`Add ${listed} to the route or to ${controller.displayName}`],
          related: [
            { message: `The "${group.group}" group is required`, location: (inOrder[0] ?? group).definition },
            { message: `${controller.displayName} is declared here`, location: controller.location },
          ],
        })
      }
    }
  }
}

function describeOptions(entry: Definition): string {
  const group = entry.group === entry.key ? 'no group' : `group "${entry.group}"`
  return entry.required ? `${group}, required` : group
}

const GRAMMAR_HINTS: readonly string[] = [
  "Paths are made of static segments (letters, digits and - . _ ~ ! $ & ' + , ; = @), :name parameters and a trailing * wildcard",
]

/** `:param` of the path ↔ `@Param('name')` parameters of the handler. */
function checkParams(ctx: Context, route: HttpRouteData, path: RoutePath, where: string): void {
  const declared = new Set(path.params)
  const consumed = new Set<string>()
  let everything = false
  for (const param of route.params) {
    if (param.source === 'context' || param.source === 'request') {
      everything = true // ctx.params / the native request give access to every parameter
      continue
    }
    if (param.source !== 'param') {
      continue
    }
    if (param.key === undefined) {
      everything = true
      continue
    }
    if (declared.has(param.key)) {
      consumed.add(param.key)
      continue
    }
    const available = path.params.filter(name => name !== WILDCARD_PARAM).map(name => `:${name}`)
    invalidRoute(
      ctx,
      param.location,
      `@Param('${param.key}') of ${where}: the route ${route.method} ${route.fullPath} has no ${param.key === WILDCARD_PARAM ? 'wildcard' : `":${param.key}" parameter`}`,
      [
        available.length > 0
          ? `Parameters of the route: ${available.join(', ')}`
          : `Add ":${param.key}" to the route path`,
      ],
    )
  }
  if (everything || !route.complete) {
    return // a parameter could not be analysed (already reported): do not guess what it consumes
  }
  for (const name of path.params) {
    if (name !== WILDCARD_PARAM && !consumed.has(name)) {
      invalidRoute(
        ctx,
        route.pathLocation,
        `Route ${route.method} ${route.fullPath} declares ":${name}" but ${where} has no @Param('${name}') parameter`,
        [`Add a parameter: @Param('${name}') ${name}: string`],
      )
    }
  }
}

function invalidRoute(ctx: Context, location: Location, message: string, hints: readonly string[]): void {
  ctx.report({ code: Codes.InvalidRoute, severity: 'error', message, location, hints })
}
