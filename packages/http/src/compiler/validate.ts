/**
 * `validate` of the `@znight/http` compiler extension: route paths (grammar of `@znight/http/path`),
 * `:param` ↔ `@Param` consistency and duplicate routes across every controller (ZNIGHT007).
 */
import type { Location, ValidateContext } from '@znight/compiler'
import type { RoutePath } from '../path.ts'
import type { HttpControllerData, HttpRouteData } from './model.ts'

import { checkRoutePath, compareStrings, parseRoutePath, WILDCARD_PARAM } from '../path.ts'
import { Codes } from './model.ts'

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
