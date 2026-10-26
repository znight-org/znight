/**
 * Route path grammar of `@znight/http`, shared by the runtime (adapters, router) and the compiler
 * extension (ZNIGHT007 diagnostics, `fullPath`). This module is **pure**: no imports, no I/O, no
 * global state, so the compiler can load it without loading the HTTP runtime.
 *
 * Grammar (after normalisation, see {@link normalizePath}):
 *
 * ```
 * path     = "/" | ( "/" segment )+
 * segment  = static | param | wildcard            ; wildcard only as the last segment
 * static   = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "!" / "$" / "&" / "'" / "+" / "," / ";" / "=" / "@" )
 * param    = ":" name                              ; name = [A-Za-z_][A-Za-z0-9_]*, unique in the path
 * wildcard = "*"                                   ; matches the rest of the path (may be empty)
 * ```
 *
 * Matching is case-sensitive and works on the raw (percent-encoded) request path. A `:param`
 * matches one non-empty segment; `/files/*` matches `/files/` and `/files/a/b` (not `/files`).
 */

/** A segment of a parsed route path. */
export type RouteSegment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string }
  | { readonly kind: 'wildcard' }

/** A validated, normalised route path. */
export interface RoutePath {
  /** Normalised path (`/users/:id`, `/` for the root). */
  readonly path: string
  readonly segments: readonly RouteSegment[]
  /** Parameter names, in order. The wildcard, when present, is last and named {@link WILDCARD_PARAM}. */
  readonly params: readonly string[]
  readonly wildcard: boolean
  /**
   * Matching shape: param names are erased (`/users/:` for `/users/:id`). Two routes with the same
   * method and shape conflict.
   */
  readonly shape: string
}

/** A grammar violation. */
export interface RoutePathIssue {
  readonly message: string
  /** The offending segment, when the issue concerns one. */
  readonly segment?: string
}

/** Name of the parameter holding the value matched by a trailing wildcard (`ctx.params['*']`). */
export const WILDCARD_PARAM = '*'

/** Characters allowed in static segments. */
const STATIC_SEGMENT = /^[A-Za-z0-9\-._~!$&'+,;=@]+$/
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const EDGE_SLASHES = /^\/+|\/+$/g

/** Error thrown by {@link parseRoutePath}. */
export class RoutePathError extends TypeError {
  readonly path: string
  readonly issue: RoutePathIssue

  constructor(path: string, issue: RoutePathIssue) {
    super(`Invalid route path "${path}": ${issue.message}`)
    this.name = 'RoutePathError'
    this.path = path
    this.issue = issue
  }
}

/**
 * Normalises a path: exactly one leading slash, no trailing slash (except the root `/`). Inner
 * content is left untouched (`//` stays and is rejected by {@link parseRoutePath}).
 *
 * `normalizePath('users/')` → `/users`, `normalizePath('')` → `/`.
 */
export function normalizePath(path: string): string {
  const trimmed = path.replace(EDGE_SLASHES, '')
  return trimmed === '' ? '/' : `/${trimmed}`
}

/**
 * Joins path parts (global prefix, controller base path, route path) with single slashes and
 * normalises the result. Empty parts and `/` are ignored.
 *
 * `joinPaths('/api', '/users/', ':id')` → `/api/users/:id`, `joinPaths('/', '')` → `/`.
 */
export function joinPaths(...parts: readonly string[]): string {
  let result = ''
  for (const part of parts) {
    const trimmed = part.replace(EDGE_SLASHES, '')
    if (trimmed !== '') result += `/${trimmed}`
  }
  return result === '' ? '/' : result
}

/** Validates `path` (normalised first). Returns the first issue, or `undefined` when it is valid. */
export function checkRoutePath(path: string): RoutePathIssue | undefined {
  const result = analyse(path)
  return 'message' in result ? result : undefined
}

/**
 * Parses and validates a route path (normalised first).
 *
 * @throws RoutePathError when the path violates the grammar.
 */
export function parseRoutePath(path: string): RoutePath {
  const result = analyse(path)
  if ('message' in result) throw new RoutePathError(path, result)
  return result
}

function analyse(input: string): RoutePath | RoutePathIssue {
  if (typeof input !== 'string') return { message: 'a route path must be a string' }
  if (input.includes('?') || input.includes('#')) {
    return { message: 'a route path cannot contain "?" or "#" (query strings are not part of routes)' }
  }
  const path = normalizePath(input)
  if (path === '/') return { path, segments: [], params: [], wildcard: false, shape: '/' }
  const raw = path.slice(1).split('/')
  const segments: RouteSegment[] = []
  const params: string[] = []
  for (let index = 0; index < raw.length; index++) {
    const segment = raw[index] as string
    if (segment === '') return { message: 'empty segment ("//")' }
    if (segment === '*') {
      if (index !== raw.length - 1) {
        return { message: 'the wildcard "*" must be the last segment', segment }
      }
      segments.push({ kind: 'wildcard' })
      params.push(WILDCARD_PARAM)
      continue
    }
    if (segment.includes('*')) {
      return { message: `"*" must be a whole segment (found "${segment}")`, segment }
    }
    if (segment.startsWith(':')) {
      const name = segment.slice(1)
      if (!PARAM_NAME.test(name)) {
        return {
          message: `invalid parameter name "${name}" (expected letters, digits and "_", not starting with a digit)`,
          segment,
        }
      }
      if (params.includes(name)) return { message: `duplicate parameter ":${name}"`, segment }
      segments.push({ kind: 'param', name })
      params.push(name)
      continue
    }
    if (segment.includes(':')) {
      return { message: `":" is only allowed at the start of a segment (found "${segment}")`, segment }
    }
    if (segment === '.' || segment === '..') return { message: 'dot segments ("." and "..") are not allowed', segment }
    if (!STATIC_SEGMENT.test(segment)) {
      const bad = [...segment].find(char => !STATIC_SEGMENT.test(char)) ?? segment
      return {
        message: `invalid character ${JSON.stringify(bad)} in "${segment}" (allowed: letters, digits and - . _ ~ ! $ & ' + , ; = @)`,
        segment,
      }
    }
    segments.push({ kind: 'static', value: segment })
  }
  return { path, segments, params, wildcard: params.at(-1) === WILDCARD_PARAM, shape: shapeOf(segments) }
}

function shapeOf(segments: readonly RouteSegment[]): string {
  let shape = ''
  for (const segment of segments) {
    if (segment.kind === 'static') shape += `/${segment.value}`
    else if (segment.kind === 'param') shape += '/:'
    else shape += '/*'
  }
  return shape === '' ? '/' : shape
}

/**
 * Matches a raw request path (no query string) against a route. Returns the **raw**
 * (percent-encoded) parameter values, or `undefined` when the path does not match.
 */
export function matchRoutePath(route: RoutePath, path: string): Record<string, string> | undefined {
  if (path.charCodeAt(0) !== 47 /* / */) return undefined
  const segments = route.segments
  if (segments.length === 0) return path === '/' ? {} : undefined
  const params: Record<string, string> = {}
  let position = 1
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] as RouteSegment
    if (segment.kind === 'wildcard') {
      params[WILDCARD_PARAM] = path.slice(position)
      return params
    }
    const slash = path.indexOf('/', position)
    const end = slash === -1 ? path.length : slash
    const value = path.slice(position, end)
    if (segment.kind === 'static') {
      if (value !== segment.value) return undefined
    } else {
      if (value === '') return undefined
      params[segment.name] = value
    }
    if (index === segments.length - 1) return end === path.length ? params : undefined
    if (slash === -1) return undefined
    position = slash + 1
  }
  return params
}

/** Decodes a raw parameter value. Returns `undefined` when it is not valid percent-encoding. */
export function decodePathValue(value: string): string | undefined {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

const RANK = { static: 0, param: 1, wildcard: 2 } as const

/**
 * Orders routes from the most to the least specific (static segments before parameters before the
 * wildcard, compared segment by segment), then by path. Registering routes in this order makes
 * first-match routers (Express, Hono) behave like specificity-based ones (Fastify, the built-in
 * router).
 */
export function compareRoutePaths(a: RoutePath, b: RoutePath): number {
  const length = Math.min(a.segments.length, b.segments.length)
  for (let index = 0; index < length; index++) {
    const left = a.segments[index] as RouteSegment
    const right = b.segments[index] as RouteSegment
    const rank = RANK[left.kind] - RANK[right.kind]
    if (rank !== 0) return rank
    if (left.kind === 'static' && right.kind === 'static' && left.value !== right.value) {
      return left.value < right.value ? -1 : 1
    }
  }
  if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length
  return compareStrings(a.path, b.path)
}

/** Ordinal string comparison (locale-independent, deterministic). */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Fastify / find-my-way pattern (`/users/:id`, `/files/*`). */
export function toFastifyPath(route: RoutePath): string {
  return toColonPath(route, '*')
}

/**
 * Hono pattern. The wildcard becomes a regexp parameter so that `/files/*` does not match `/files`
 * (Hono's own `*` does).
 */
export function toHonoPath(route: RoutePath): string {
  return toColonPath(route, ':__znight_wildcard{.*}')
}

function toColonPath(route: RoutePath, wildcard: string): string {
  if (route.segments.length === 0) return '/'
  let result = ''
  for (const segment of route.segments) {
    if (segment.kind === 'static') result += `/${segment.value}`
    else if (segment.kind === 'param') result += `/:${segment.name}`
    else result += `/${wildcard}`
  }
  return result
}

/**
 * Anchored regular expression source matching the raw path of a route, without capturing groups
 * (`^\/users\/[^/]+$`). Used by the Express adapter, which matches regular expressions against the
 * raw path.
 */
export function toRegExpSource(route: RoutePath): string {
  if (route.segments.length === 0) return '^\\/$'
  let source = '^'
  for (const segment of route.segments) {
    if (segment.kind === 'static') source += `\\/${escapeRegExp(segment.value)}`
    else if (segment.kind === 'param') source += '\\/[^/]+'
    else source += '\\/.*'
  }
  return `${source}$`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
