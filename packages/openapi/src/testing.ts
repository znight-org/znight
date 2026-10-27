/**
 * `@znight/openapi/testing`: checks that a response matches its documentation (status, media type,
 * documented headers, JSON body against the resolved schema). JSON Schema 2020-12 validation uses
 * the optional peer `@cfworker/json-schema` (no code generation: Bun, Node.js and edge runtimes).
 */
import type { JsonSchema, OpenApiObject, ReferenceObject, ResponseObject } from './types.ts'

import { createRequire } from 'node:module'

/** A problem found by {@link validateResponse}. */
export interface ResponseIssue {
  /** `status`, `headers.location`, `body.items[0].id`... */
  readonly path: string
  readonly message: string
  /** `operation`, `status`, `media-type`, `header`, `json`, or the failing JSON Schema keyword (`type`, `required`...). */
  readonly keyword: string
}

/** A response: an `InjectResponse` of `@znight/http` / `@znight/testing`, or a plain object. */
export interface ResponseLike {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly body: string
}

/** What to check. */
export interface ValidateResponseInput {
  /** HTTP method (`'GET'`). */
  readonly method: string
  /** Path template of the document (`/books/{id}`). */
  readonly path: string
  readonly response: ResponseLike
}

interface CfValidator {
  validate(instance: unknown): {
    valid: boolean
    errors: { keyword: string; instanceLocation: string; error: string }[]
  }
}
type CfValidatorClass = new (schema: object, draft?: string, shortCircuit?: boolean) => CfValidator

let validatorClass: CfValidatorClass | undefined

function loadValidator(): CfValidatorClass {
  if (validatorClass !== undefined) return validatorClass
  try {
    const module = createRequire(import.meta.url)('@cfworker/json-schema') as { Validator?: CfValidatorClass }
    if (typeof module.Validator !== 'function') throw new Error('no Validator export')
    validatorClass = module.Validator
    return validatorClass
  } catch (error) {
    throw new Error(
      'validateResponse() needs the optional peer dependency @cfworker/json-schema (npm install -D @cfworker/json-schema)',
      {
        cause: error,
      },
    )
  }
}

const COMPOSITE = new Set([
  'properties',
  'items',
  'prefixItems',
  '$ref',
  'allOf',
  'patternProperties',
  'dependentSchemas',
  '$dynamicRef',
])

/**
 * Checks `response` against the documentation of `method path` in `document`. Returns `[]` when it
 * matches.
 *
 * ```ts
 * const response = await app.inject({ method: 'GET', url: '/books/1' })
 * expect(validateResponse(document, { method: 'GET', path: '/books/{id}', response })).toEqual([])
 * ```
 *
 * The status is looked up as an exact code, then its range (`4XX`), then `default`; the media type
 * against the documented ones (ranges such as `image/*` included); documented headers marked
 * `required` must be present; a JSON body is validated against its schema (`$ref`s to the
 * components followed).
 */
export function validateResponse(document: OpenApiObject, input: ValidateResponseInput): ResponseIssue[] {
  const issues: ResponseIssue[] = []
  const method = input.method.toLowerCase() as 'get'
  const operation = document.paths?.[input.path]?.[method]
  if (operation === undefined) {
    return [
      {
        path: 'operation',
        keyword: 'operation',
        message: `${input.method.toUpperCase()} ${input.path} is not documented`,
      },
    ]
  }
  const status = String(input.response.status)
  const responses = operation.responses ?? {}
  const entry = responses[status] ?? responses[`${status.charAt(0)}XX`] ?? responses['default']
  if (entry === undefined) {
    return [
      {
        path: 'status',
        keyword: 'status',
        message: `The status ${status} is not documented (documented: ${Object.keys(responses).join(', ') || 'none'})`,
      },
    ]
  }
  const documented = resolveResponse(document, entry)
  if (documented === undefined) {
    return [
      {
        path: 'status',
        keyword: '$ref',
        message: `Cannot resolve the response ${JSON.stringify((entry as ReferenceObject).$ref)}`,
      },
    ]
  }
  // headers
  const headers = lowerCase(input.response.headers)
  for (const [name, header] of Object.entries(documented.headers ?? {})) {
    if ((header as { required?: boolean }).required === true && headers[name.toLowerCase()] === undefined) {
      issues.push({
        path: `headers.${name.toLowerCase()}`,
        keyword: 'header',
        message: `The documented header "${name}" is missing`,
      })
    }
  }
  // media type
  const content = documented.content
  const body = input.response.body
  const contentType = headers['content-type']
  const mediaType = (Array.isArray(contentType) ? contentType[0] : contentType)?.split(';')[0]?.trim().toLowerCase()
  if (content === undefined || Object.keys(content).length === 0) {
    if (body !== '')
      issues.push({
        path: 'body',
        keyword: 'content',
        message: `The ${status} response is documented without body, but it has one`,
      })
    return issues
  }
  if (mediaType === undefined) {
    if (body !== '')
      issues.push({
        path: 'headers.content-type',
        keyword: 'media-type',
        message: 'The response has a body but no content-type',
      })
    return issues
  }
  const key = Object.keys(content).find(candidate => mediaMatches(candidate, mediaType))
  if (key === undefined) {
    issues.push({
      path: 'headers.content-type',
      keyword: 'media-type',
      message: `The media type ${mediaType} is not documented (documented: ${Object.keys(content).join(', ')})`,
    })
    return issues
  }
  const schema = content[key]?.schema
  if (schema === undefined || !isJsonMediaType(mediaType)) return issues
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    issues.push({ path: 'body', keyword: 'json', message: 'The body is not valid JSON' })
    return issues
  }
  const Validator = loadValidator()
  // the validator annotates the schemas it reads: work on a copy of the (frozen) document parts
  const root = structuredClone({ ...(schema as JsonSchema), components: document.components ?? {} })
  const result = new Validator(root, '2020-12', false).validate(value)
  if (result.valid) return issues
  const leaves = result.errors.filter(error => !COMPOSITE.has(error.keyword))
  for (const error of leaves.length > 0 ? leaves : result.errors) {
    issues.push({ path: readablePath(error.instanceLocation), keyword: error.keyword, message: error.error })
  }
  return issues
}

function resolveResponse(document: OpenApiObject, entry: ResponseObject | ReferenceObject): ResponseObject | undefined {
  let current: ResponseObject | ReferenceObject | undefined = entry
  for (let depth = 0; depth < 8 && current !== undefined && '$ref' in current; depth++) {
    const name: string = current.$ref.replace(/^#\/components\/responses\//, '')
    current = document.components?.responses?.[name]
  }
  return current === undefined || '$ref' in current ? undefined : current
}

function lowerCase(headers: ResponseLike['headers']): Record<string, string | readonly string[] | undefined> {
  const result: Record<string, string | readonly string[] | undefined> = {}
  for (const [name, value] of Object.entries(headers)) result[name.toLowerCase()] = value
  return result
}

function mediaMatches(documented: string, actual: string): boolean {
  const pattern = documented.split(';')[0]?.trim().toLowerCase() ?? ''
  if (pattern === '*/*' || pattern === actual) return true
  return pattern.endsWith('/*') && actual.startsWith(pattern.slice(0, -1))
}

function isJsonMediaType(mediaType: string): boolean {
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

/** `#/items/0/id` → `body.items[0].id`. */
function readablePath(pointer: string): string {
  const segments = pointer
    .replace(/^#\/?/, '')
    .split('/')
    .filter(segment => segment !== '')
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
  let path = 'body'
  for (const segment of segments)
    if (/^\d+$/.test(segment)) path += `[${segment}]`
    else if (/^[A-Za-z_$][\w$]*$/.test(segment)) path += `.${segment}`
    else path += `[${JSON.stringify(segment)}]`
  return path
}
