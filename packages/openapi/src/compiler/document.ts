/**
 * `@OpenApiDocument` options and `securityScheme()` definitions, read statically and checked
 * (ZNIGHT030 for malformed values, ZNIGHT036 for security requirements).
 */
import type { DefinitionInfo, Location, StaticValue, ValidateContext, ValueRef } from '@znight/compiler'
import type { InfoObject, JsonValue, SecurityRequirementObject, SecuritySchemeObject, TagObject } from '../types.ts'
import type { OpenApiStored } from './model.ts'

import { OPENAPI_VERSION } from '../shared.ts'
import { Codes, HttpIds, Ids } from './model.ts'
import { describe, findReservedKey, isAbsoluteUrl, isRecord, isRef, isUrlReference, toJson } from './values.ts'

type Context = ValidateContext<OpenApiStored>

/** Style of default operation ids. */
export type OperationIdStyle = 'controller.handler' | 'handler' | 'Controller_handler'

/** A resolved `securityScheme()`. */
export interface SchemeModel {
  readonly identity: string
  readonly name: string
  readonly definition: SecuritySchemeObject
  readonly location: Location
  /** Scopes declared by the flows (oauth2), `undefined` when the scheme takes no scope check. */
  readonly scopes: ReadonlySet<string> | undefined
  readonly scoped: boolean
}

/** A requirement input resolved to schemes (AND), each with its scopes. */
export type RequirementModel = readonly {
  readonly scheme: SchemeModel
  readonly scopes: readonly string[] | undefined
}[]

/** A `decisions` entry. */
export interface DecisionModel {
  readonly identity: string
  readonly text: string
  readonly location: Location
  readonly security: readonly RequirementModel[]
  readonly scopesFromValue: boolean
  used: boolean
}

/** The checked document options. */
export interface DocumentModel {
  readonly identity: string | undefined
  readonly location: Location | undefined
  readonly info: InfoObject
  readonly servers: readonly JsonValue[] | undefined
  readonly tags: readonly TagObject[]
  readonly externalDocs: JsonValue | undefined
  readonly security: readonly RequirementModel[] | undefined
  readonly decisions: readonly DecisionModel[]
  readonly operationIds: OperationIdStyle
  readonly errors: false | { readonly contentType: string; readonly schema: ValueRef | undefined }
  readonly strict: boolean
  readonly jsdoc: boolean
  readonly extensions: Readonly<Record<string, JsonValue>>
}

const OPTION_KEYS = new Set([
  'info',
  'servers',
  'tags',
  'externalDocs',
  'security',
  'decisions',
  'operationIds',
  'errors',
  'strict',
  'jsdoc',
  'extensions',
])
const INFO_KEYS = new Set(['title', 'version', 'summary', 'description', 'termsOfService', 'contact', 'license'])
const SPDX = /^[A-Za-z0-9.+-]+(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$/

/** Security schemes declared with `securityScheme(name, definition)`, by identity of their `const`. */
export class SchemeRegistry {
  readonly #ctx: Context
  readonly #schemes = new Map<string, SchemeModel | null>()
  readonly #byName = new Map<string, SchemeModel>()
  readonly #definitions: ReadonlyMap<string, DefinitionInfo>
  /** Schemes referenced by the document, by name. */
  readonly used: Map<string, SchemeModel> = new Map()

  constructor(ctx: Context) {
    this.#ctx = ctx
    this.#definitions = new Map(
      ctx.definitionsOf(Ids.securityScheme).map(definition => [definition.identity, definition]),
    )
  }

  /** The scheme a reference points to (`undefined` and a ZNIGHT036 when it is not a scheme). */
  resolve(ref: ValueRef): SchemeModel | undefined {
    const identity = ref.identity
    if (identity !== undefined && this.#schemes.has(identity)) return this.#schemes.get(identity) ?? undefined
    const definition = identity === undefined ? undefined : this.#definitions.get(identity)
    if (definition === undefined || identity === undefined) {
      this.#ctx.report({
        code: Codes.InvalidSecurityRequirement,
        severity: 'error',
        message: `${ref.text} is not a security scheme declared with securityScheme()`,
        location: ref.location,
        hints: [
          "Declare it: export const ApiKey = securityScheme('apiKey', { type: 'apiKey', in: 'header', name: 'x-api-key' })",
        ],
      })
      return undefined
    }
    const scheme = this.#parse(definition)
    this.#schemes.set(identity, scheme ?? null)
    return scheme
  }

  #parse(definition: DefinitionInfo): SchemeModel | undefined {
    const [nameArg, definitionArg] = definition.args
    const name = nameArg?.evaluated ? nameArg.value : undefined
    const value = definitionArg?.evaluated ? definitionArg.value : undefined
    const malformed = (message: string, location: Location = definition.call): undefined => {
      this.#ctx.report({
        code: Codes.InvalidOpenApiDefinition,
        severity: 'error',
        message: `Invalid security scheme ${definition.displayName}: ${message}`,
        location,
        hints: ['securityScheme(name, definition) takes a static name and an OpenAPI Security Scheme Object'],
      })
      return undefined
    }
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
      return malformed('the name must be a static string of [A-Za-z0-9._-]', nameArg?.location)
    }
    if (!isRecord(value)) return malformed('the definition must be a static object', definitionArg?.location)
    const reserved = findReservedKey(value)
    if (reserved !== undefined) return malformed(`"$znight" is a reserved key (${reserved})`, definitionArg?.location)
    const json = toJson(value)
    if (!isRecord(json)) return malformed('the definition must be JSON', definitionArg?.location)
    const where = definitionArg?.location
    const text = (key: string, required: boolean): string | undefined => {
      const field = json[key]
      if (field === undefined && !required) return undefined
      if (typeof field !== 'string' || field === '') throw new SchemeError(`"${key}" must be a non-empty string`)
      return field
    }
    let scopes: Set<string> | undefined
    try {
      for (const key of Object.keys(json)) {
        if (!ALLOWED_SCHEME_KEYS[String(json['type'])]?.has(key) && !key.startsWith('x-') && key !== 'description') {
          throw new SchemeError(`unknown field "${key}" for a ${String(json['type'])} scheme`)
        }
      }
      switch (json['type']) {
        case 'apiKey': {
          text('name', true)
          const location = text('in', true)
          if (location !== 'query' && location !== 'header' && location !== 'cookie') {
            throw new SchemeError('"in" must be "query", "header" or "cookie"')
          }
          break
        }
        case 'http':
          text('scheme', true)
          text('bearerFormat', false)
          break
        case 'oauth2': {
          const flows = json['flows']
          if (!isRecord(flows) || Object.keys(flows).length === 0) throw new SchemeError('"flows" must declare a flow')
          scopes = new Set()
          for (const [flow, body] of Object.entries(flows)) {
            if (!FLOW_URLS[flow]) throw new SchemeError(`unknown flow "${flow}"`)
            if (!isRecord(body) || !isRecord(body['scopes'])) throw new SchemeError(`the ${flow} flow needs "scopes"`)
            for (const url of FLOW_URLS[flow] ?? []) {
              const field = body[url]
              if (typeof field !== 'string' || !isUrlReference(field)) {
                throw new SchemeError(`the ${flow} flow needs a "${url}" URL`)
              }
            }
            for (const scope of Object.keys(body['scopes'])) scopes.add(scope)
          }
          break
        }
        case 'openIdConnect': {
          const url = text('openIdConnectUrl', true) as string
          if (!isUrlReference(url)) throw new SchemeError('"openIdConnectUrl" must be a URL')
          break
        }
        case 'mutualTLS':
          break
        default:
          throw new SchemeError('"type" must be "apiKey", "http", "oauth2", "openIdConnect" or "mutualTLS"')
      }
    } catch (error) {
      if (error instanceof SchemeError) return malformed(error.message, where)
      throw error
    }
    const scheme: SchemeModel = {
      identity: definition.identity,
      name,
      definition: json as unknown as SecuritySchemeObject,
      location: definition.location,
      scopes,
      scoped: json['type'] === 'oauth2' || json['type'] === 'openIdConnect',
    }
    const other = this.#byName.get(name)
    if (other !== undefined && JSON.stringify(other.definition) !== JSON.stringify(scheme.definition)) {
      this.#ctx.report({
        code: Codes.InvalidSecurityRequirement,
        severity: 'error',
        message: `Two security schemes are named "${name}" with different definitions: ${definition.displayName} and ${other.identity}`,
        location: definition.location,
        related: [{ message: 'the other scheme', location: other.location }],
        hints: ['Give each scheme its own name, or reuse one declaration'],
      })
      return undefined
    }
    this.#byName.set(name, scheme)
    return scheme
  }

  /**
   * Resolves a requirement input (`ApiKey`, `[Bearer, Tenant]`, `{ scheme, scopes }`) to schemes.
   * Reports ZNIGHT036 and returns `undefined` when it is invalid.
   */
  requirement(value: StaticValue, location: Location): RequirementModel | undefined {
    const report = (message: string, hints: readonly string[] = REQUIREMENT_HINTS): undefined => {
      this.#ctx.report({ code: Codes.InvalidSecurityRequirement, severity: 'error', message, location, hints })
      return undefined
    }
    const one = (item: StaticValue, scopes: readonly string[] | undefined): RequirementModel[number] | undefined => {
      if (!isRef(item)) return report(`${describe(item)} is not a security scheme declared with securityScheme()`)
      const scheme = this.resolve(item)
      if (scheme === undefined) return undefined
      if (scopes !== undefined && scopes.length > 0) {
        if (!scheme.scoped) {
          return report(
            `Scopes are only allowed on oauth2 and openIdConnect schemes, not on "${scheme.name}" (${String(scheme.definition.type)})`,
            ['Remove the scopes, or use an oauth2 / openIdConnect scheme'],
          )
        }
        const unknown = scheme.scopes === undefined ? [] : scopes.filter(scope => !scheme.scopes?.has(scope))
        if (unknown.length > 0) {
          return report(
            `The scope${unknown.length > 1 ? 's' : ''} ${unknown.map(scope => `"${scope}"`).join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not declared by the flows of "${scheme.name}"`,
            [`Declared scopes: ${[...(scheme.scopes ?? [])].join(', ') || 'none'}`],
          )
        }
      }
      return { scheme, scopes }
    }
    if (Array.isArray(value)) {
      const items: RequirementModel[number][] = []
      for (const item of value as readonly StaticValue[]) {
        const resolved = one(item, undefined)
        if (resolved === undefined) return undefined
        items.push(resolved)
      }
      return items
    }
    if (isRecord(value)) {
      const scopes = value['scopes']
      if (!Array.isArray(scopes) || !(scopes as readonly StaticValue[]).every(scope => typeof scope === 'string')) {
        return report('{ scheme, scopes } needs a static array of scope names')
      }
      const resolved = one(value['scheme'] as StaticValue, scopes as readonly string[])
      return resolved === undefined ? undefined : [resolved]
    }
    const resolved = one(value, undefined)
    return resolved === undefined ? undefined : [resolved]
  }

  /** Requirement objects of resolved requirements (`scopes` overrides every scheme's scopes). */
  objects(requirements: readonly RequirementModel[], scopes?: readonly string[]): SecurityRequirementObject[] {
    return requirements.map(requirement => {
      const object: Record<string, readonly string[]> = {}
      for (const { scheme, scopes: own } of requirement) {
        this.used.set(scheme.name, scheme)
        object[scheme.name] = [...(scopes ?? own ?? [])]
      }
      return object
    })
  }
}

class SchemeError extends Error {}

const REQUIREMENT_HINTS = [
  'A requirement is a scheme (ApiKey), several schemes that all apply ([Bearer, Tenant]) or { scheme: OAuth, scopes: [...] }',
]

const ALLOWED_SCHEME_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  apiKey: new Set(['type', 'name', 'in']),
  http: new Set(['type', 'scheme', 'bearerFormat']),
  oauth2: new Set(['type', 'flows']),
  openIdConnect: new Set(['type', 'openIdConnectUrl']),
  mutualTLS: new Set(['type']),
}

const FLOW_URLS: Readonly<Record<string, readonly string[]>> = {
  implicit: ['authorizationUrl'],
  password: ['tokenUrl'],
  clientCredentials: ['tokenUrl'],
  authorizationCode: ['authorizationUrl', 'tokenUrl'],
}

/** Reads and checks the `@OpenApiDocument` options (and the defaults of `package.json`). */
export function readDocument(ctx: Context, schemes: SchemeRegistry): DocumentModel {
  const documents = ctx.stored.filter(data => data.kind === 'document')
  for (const extra of documents.slice(1)) {
    const first = documents[0]
    ctx.report({
      code: Codes.InvalidOpenApiDefinition,
      severity: 'error',
      message: `An application has one @OpenApiDocument: ${extra.displayName} and ${first?.displayName ?? '?'} both declare one`,
      location: extra.location,
      ...(first === undefined
        ? {}
        : { related: [{ message: 'the other @OpenApiDocument', location: first.location }] }),
      hints: ['Keep one class with @OpenApiDocument; filter operations with OpenApiPlugin.configure({ filter })'],
    })
  }
  const stored = documents[0]
  const cls = stored === undefined ? undefined : ctx.classInfo(stored.identity)
  const decorator = cls?.decorators.find(candidate => candidate.identity === Ids.OpenApiDocument)
  const arg = decorator?.args[0]
  const value: StaticValue = arg?.evaluated === true ? arg.value : undefined
  const location = arg?.location ?? decorator?.location
  const invalid = (message: string, hints: readonly string[] = []): void => {
    ctx.report({
      code: Codes.InvalidOpenApiDefinition,
      severity: 'error',
      message: `Invalid @OpenApiDocument options: ${message}`,
      ...(location === undefined ? {} : { location }),
      hints,
    })
  }
  const options: Readonly<Record<string, StaticValue>> = isRecord(value) ? value : {}
  if (value !== undefined && !isRecord(value)) invalid(`expected an object, received ${describe(value)}`)
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) invalid(`unknown option "${key}"`, [`Options: ${[...OPTION_KEYS].join(', ')}`])
  }
  const reserved = findReservedKey(options)
  if (reserved !== undefined) invalid(`"$znight" is a reserved key (${reserved})`)

  const bool = (key: string, fallback: boolean): boolean => {
    const option = options[key]
    if (option === undefined) return fallback
    if (typeof option !== 'boolean') {
      invalid(`"${key}" must be true or false`)
      return fallback
    }
    return option
  }
  const json = (key: string): JsonValue | undefined => {
    const option = options[key]
    if (option === undefined) return undefined
    const converted = toJson(option)
    if (converted === undefined) invalid(`"${key}" must be a static JSON value`)
    return converted
  }

  // info
  const doc = bool('jsdoc', true) ? cls?.doc : undefined
  const manifest = ctx.project.rootPackage?.json ?? {}
  const infoOption = json('info')
  const info: Record<string, JsonValue> = {}
  if (infoOption !== undefined && !isRecord(infoOption)) invalid('"info" must be an object')
  const given = isRecord(infoOption) ? (infoOption as Readonly<Record<string, JsonValue>>) : {}
  for (const key of Object.keys(given)) {
    if (!INFO_KEYS.has(key) && !key.startsWith('x-')) invalid(`unknown field "info.${key}"`)
  }
  const manifestString = (key: string): string | undefined => {
    const field = manifest[key]
    return typeof field === 'string' && field !== '' ? field : undefined
  }
  const title = given['title'] ?? doc?.summary ?? manifestString('name') ?? 'API'
  const version = given['version'] ?? manifestString('version') ?? '0.0.0'
  if (typeof title !== 'string' || title === '') invalid('"info.title" must be a non-empty string')
  if (typeof version !== 'string' || version === '') invalid('"info.version" must be a non-empty string')
  info['title'] = typeof title === 'string' ? title : 'API'
  info['version'] = typeof version === 'string' ? version : '0.0.0'
  for (const key of ['summary', 'termsOfService', 'contact', 'license']) {
    if (given[key] !== undefined) info[key] = given[key] as JsonValue
  }
  const description = given['description'] ?? doc?.description ?? manifestString('description')
  if (description !== undefined) info['description'] = description
  if (info['license'] === undefined) {
    const license = manifestString('license')
    if (license !== undefined && SPDX.test(license) && license !== 'UNLICENSED') {
      info['license'] = { name: license, identifier: license }
    }
  }
  for (const [key, field] of Object.entries(given)) if (key.startsWith('x-')) info[key] = field
  checkInfo(info, invalid)

  // servers, tags, externalDocs, extensions
  const servers = json('servers')
  if (servers !== undefined) {
    if (
      !Array.isArray(servers) ||
      servers.some(server => !isRecord(server) || !isUrlReference(String(server['url'])))
    ) {
      invalid('"servers" must be an array of { url, description?, variables? } with valid URLs')
    }
  }
  const tagsOption = json('tags')
  const tags: TagObject[] = []
  if (tagsOption !== undefined) {
    if (Array.isArray(tagsOption)) {
      const seen = new Set<string>()
      for (const tag of tagsOption) {
        if (!isRecord(tag) || typeof tag['name'] !== 'string' || tag['name'] === '') {
          invalid('every tag needs a non-empty "name"')
          continue
        }
        if (seen.has(tag['name'])) invalid(`the tag "${tag['name']}" is declared twice`)
        seen.add(tag['name'])
        tags.push(tag as unknown as TagObject)
      }
    } else invalid('"tags" must be an array of { name, description? }')
  }
  const externalDocs = json('externalDocs')
  if (externalDocs !== undefined && (!isRecord(externalDocs) || !isAbsoluteUrl(String(externalDocs['url'])))) {
    invalid('"externalDocs" must be { url, description? } with an absolute URL')
  }
  const extensionsOption = json('extensions')
  const extensions: Record<string, JsonValue> = {}
  if (extensionsOption !== undefined) {
    if (isRecord(extensionsOption)) {
      for (const [key, field] of Object.entries(extensionsOption as Readonly<Record<string, JsonValue>>)) {
        if (key.startsWith('x-')) extensions[key] = field
        else invalid(`the extension "${key}" must start with "x-"`)
      }
    } else invalid('"extensions" must be an object of x-* fields')
  }

  // operation ids
  const style = options['operationIds'] ?? 'controller.handler'
  if (style !== 'controller.handler' && style !== 'handler' && style !== 'Controller_handler') {
    invalid('"operationIds" must be "controller.handler", "handler" or "Controller_handler"')
  }

  // errors
  let errors: DocumentModel['errors'] = { contentType: 'application/json', schema: undefined }
  const errorsOption = options['errors']
  if (errorsOption === false) errors = false
  else if (isRecord(errorsOption)) {
    const schema = errorsOption['schema']
    const contentType = errorsOption['contentType'] ?? 'application/json'
    if (!isRef(schema)) invalid('"errors.schema" must be a Standard Schema (an exported schema)')
    if (typeof contentType !== 'string') invalid('"errors.contentType" must be a media type')
    errors = {
      contentType: typeof contentType === 'string' ? contentType : 'application/json',
      schema: isRef(schema) ? schema : undefined,
    }
  } else if (errorsOption !== undefined && errorsOption !== true) {
    invalid('"errors" must be true, false or { schema, contentType? }')
  }

  // security and decisions
  const where = location ?? decorator?.location
  let security: RequirementModel[] | undefined
  const securityOption = options['security']
  if (securityOption !== undefined && where !== undefined) {
    if (Array.isArray(securityOption)) {
      security = []
      for (const item of securityOption as readonly StaticValue[]) {
        const requirement = schemes.requirement(item, where)
        if (requirement !== undefined) security.push(requirement)
      }
    } else invalid('"security" must be an array of requirements')
  }
  const decisions = readDecisions(ctx, schemes, options['decisions'], where, invalid)

  return {
    identity: stored?.identity,
    location: decorator?.location,
    info: info as unknown as InfoObject,
    servers: Array.isArray(servers) ? servers : undefined,
    tags,
    externalDocs,
    security,
    decisions,
    operationIds: (typeof style === 'string' ? style : 'controller.handler') as OperationIdStyle,
    errors,
    strict: bool('strict', false),
    jsdoc: bool('jsdoc', true),
    extensions,
  }
}

function checkInfo(info: Readonly<Record<string, JsonValue>>, invalid: (message: string) => void): void {
  const terms = info['termsOfService']
  if (terms !== undefined && (typeof terms !== 'string' || !isAbsoluteUrl(terms))) {
    invalid('"info.termsOfService" must be an absolute URL')
  }
  const contact = info['contact']
  if (contact !== undefined) {
    if (isRecord(contact)) {
      if (contact['url'] !== undefined && !isAbsoluteUrl(String(contact['url']))) {
        invalid('"info.contact.url" must be an absolute URL')
      }
      if (contact['email'] !== undefined && !/^[^\s@]+@[^\s@]+$/.test(String(contact['email']))) {
        invalid('"info.contact.email" must be an email address')
      }
    } else invalid('"info.contact" must be { name?, url?, email? }')
  }
  const license = info['license']
  if (license !== undefined) {
    if (!isRecord(license) || typeof license['name'] !== 'string' || license['name'] === '') {
      invalid('"info.license" must be { name, identifier? } or { name, url? }')
    } else {
      if (license['identifier'] !== undefined && license['url'] !== undefined) {
        invalid('"info.license" takes "identifier" or "url", not both')
      }
      if (license['identifier'] !== undefined && !SPDX.test(String(license['identifier']))) {
        invalid('"info.license.identifier" must be an SPDX expression (MIT, Apache-2.0...)')
      }
      if (license['url'] !== undefined && !isAbsoluteUrl(String(license['url']))) {
        invalid('"info.license.url" must be an absolute URL')
      }
    }
  }
}

function readDecisions(
  ctx: Context,
  schemes: SchemeRegistry,
  value: StaticValue,
  location: Location | undefined,
  invalid: (message: string) => void,
): DecisionModel[] {
  if (value === undefined || location === undefined) return []
  if (!Array.isArray(value)) {
    invalid('"decisions" must be an array of { when, security, scopes? }')
    return []
  }
  const routeDecorators = new Set(
    ctx.definitionsOf(HttpIds.createRouteDecorator).map(definition => definition.identity),
  )
  const decisions: DecisionModel[] = []
  for (const entry of value as readonly StaticValue[]) {
    if (!isRecord(entry)) {
      invalid('every decision is { when, security, scopes? }')
      continue
    }
    const when = entry['when']
    if (!isRef(when) || when.identity === undefined || !routeDecorators.has(when.identity)) {
      ctx.report({
        code: Codes.InvalidSecurityRequirement,
        severity: 'error',
        message: `decisions[].when must be a route decorator created with createRouteDecorator(), not ${describe(when)}`,
        location: isRef(when) ? when.location : location,
        hints: ["Declare it: export const Public = createRouteDecorator('public')"],
      })
      continue
    }
    const scopes = entry['scopes']
    if (scopes !== undefined && scopes !== 'value') {
      ctx.report({
        code: Codes.InvalidSecurityRequirement,
        severity: 'error',
        message: `decisions[].scopes must be 'value' (received ${describe(scopes)})`,
        location: when.location,
        hints: [
          "{ when: Roles, security: [OAuth], scopes: 'value' } turns @Roles(['admin']) into the scopes ['admin']",
        ],
      })
      continue
    }
    const security = entry['security']
    if (!Array.isArray(security)) {
      ctx.report({
        code: Codes.InvalidSecurityRequirement,
        severity: 'error',
        message: `decisions[].security of ${when.text} must be an array of requirements ([] means public)`,
        location: when.location,
      })
      continue
    }
    const requirements: RequirementModel[] = []
    let valid = true
    for (const item of security as readonly StaticValue[]) {
      const requirement = schemes.requirement(item, when.location)
      if (requirement === undefined) valid = false
      else requirements.push(requirement)
    }
    if (!valid) continue
    decisions.push({
      identity: when.identity,
      text: when.text,
      location: when.location,
      security: requirements,
      scopesFromValue: scopes === 'value',
      used: false,
    })
  }
  return decisions
}

/** The document template: `openapi`, `info`, declared `servers`, `tags`... and the default security. */
export function documentTemplate(
  model: DocumentModel,
  security: readonly SecurityRequirementObject[] | undefined,
): Record<string, JsonValue> {
  const template: Record<string, JsonValue> = { openapi: OPENAPI_VERSION, info: model.info as unknown as JsonValue }
  if (model.servers !== undefined) template['servers'] = model.servers as JsonValue
  if (model.tags.length > 0) template['tags'] = model.tags as unknown as JsonValue
  if (model.externalDocs !== undefined) template['externalDocs'] = model.externalDocs
  if (security !== undefined) template['security'] = security as unknown as JsonValue
  for (const [key, value] of Object.entries(model.extensions)) template[key] = value
  return template
}
