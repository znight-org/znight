/**
 * The operation model (§5.4 of RFC 0002): one operation per documented route and concrete method,
 * built from the route table of `@znight/http/compiler`, the handler signatures and their JSDoc,
 * and the `@Api*` decorators.
 */
import type {
  ArgInfo,
  ClassInfo,
  DecoratorInfo,
  DocComment,
  Location,
  MethodInfo,
  ParameterInfo,
  Shape,
  StaticValue,
  ValidateContext,
} from '@znight/compiler'
import type {
  CoercionPlan,
  HttpControllerData,
  HttpParamData,
  HttpRouteData,
  MetaEntry,
  UploadData,
} from '@znight/http/compiler'
import type { ParametersPlaceholder, SchemaTemplate } from '../metadata.ts'
import type { JsonSchema, JsonValue, SecurityRequirementObject } from '../types.ts'
import type { DecisionModel, DocumentModel, RequirementModel, SchemeRegistry } from './document.ts'
import type { OpenApiStored } from './model.ts'
import type { Schemas, SchemaUse, Slots } from './schemas.ts'

import {
  compareStrings,
  ERROR_COMPONENTS,
  ERROR_RESPONSES,
  HEADER_NAME,
  isResponseStatus,
  MEDIA_TYPE,
  METHOD_ORDER,
  OPERATION_ID,
  reasonPhrase,
  schemaRef,
} from '../shared.ts'
import { Codes, EXTENSION_NAME, HttpIds, Ids } from './model.ts'
import { describe, findReservedKey, isRecord, isRef, toJson } from './values.ts'

type Context = ValidateContext<OpenApiStored>
type Json = Record<string, unknown>

/** A built operation. */
export interface OperationModel {
  readonly controller: string
  readonly handler: string
  readonly route: string
  readonly method: string
  readonly path: string
  readonly operation: Json
  readonly operationId: string
  readonly label: string
  readonly location: Location
}

/** Inputs shared by every operation. */
export interface OperationsInput {
  readonly ctx: Context
  readonly document: DocumentModel
  readonly schemes: SchemeRegistry
  readonly schemas: Schemas
  readonly slots: Slots
}

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization'])

/** Builds every operation of the application (sorted by path, then method) and the tag descriptions. */
export function buildOperations(input: OperationsInput): {
  operations: OperationModel[]
  tagDescriptions: Record<string, string>
} {
  const { ctx } = input
  const http = ctx.graph.extensions.find(extension => extension.name === 'http')
  const controllers = [...((http?.stored ?? []) as readonly HttpControllerData[])].sort((a, b) =>
    compareStrings(a.token, b.token),
  )
  const explicit = new Set<string>()
  for (const controller of controllers) {
    for (const route of controller.routes) {
      if (route.method !== 'ALL') explicit.add(`${route.method} ${pathShape(route.fullPath)}`)
    }
  }
  const operations: OperationModel[] = []
  const tagDescriptions: Record<string, string> = {}
  for (const controller of controllers) {
    const cls = ctx.classInfo(controller.identity)
    const classDecorators = owned(cls?.decorators)
    if (excluded(ctx, classDecorators, controller.displayName)) continue
    const defaultTag = controller.displayName.replace(/Controller$/, '') || controller.displayName
    const doc = input.document.jsdoc ? cls?.doc : undefined
    const classTags = tagsOf(ctx, classDecorators)
    if (classTags.length === 0 && doc !== undefined && doc.text !== '') tagDescriptions[defaultTag] = doc.text
    for (const route of controller.routes) {
      if (!route.complete) continue
      const method = cls?.methods.find(candidate => candidate.name === route.handler && !candidate.static)
      const methodDecorators = owned(method?.decorators)
      if (excluded(ctx, methodDecorators, `${controller.displayName}.${route.handler}`)) continue
      const methods =
        route.method === 'ALL'
          ? ALL_METHODS.filter(m => !explicit.has(`${m} ${pathShape(route.fullPath)}`))
          : [route.method]
      for (const httpMethod of methods) {
        operations.push(
          new OperationBuilder(input, {
            controller,
            route,
            httpMethod,
            cls,
            method,
            classDecorators,
            methodDecorators,
            classTags,
            defaultTag,
          }).build(),
        )
      }
    }
  }
  checkDuplicateIds(ctx, operations)
  unifyPathTemplates(ctx, operations)
  for (const decision of input.document.decisions) {
    if (decision.used) continue
    ctx.report({
      code: Codes.InvalidSecurityRequirement,
      severity: 'warning',
      message: `The security decision on ${decision.text} applies to no route`,
      location: decision.location,
      hints: ['Remove the decision, or apply the decorator to the routes it describes'],
    })
  }
  operations.sort(
    (a, b) => compareStrings(a.path, b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  )
  return { operations, tagDescriptions }
}

/**
 * `/books/{id}` from `/books/:id`; the trailing wildcard is `{wildcard}` (`{wildcard_1}`... when a
 * parameter of the path is named `wildcard`).
 */
export function pathTemplate(fullPath: string): string {
  const wildcard = wildcardName(fullPath)
  return fullPath
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) return `{${segment.slice(1)}}`
      return segment === '*' ? `{${wildcard}}` : segment
    })
    .join('/')
}

/** The name of the wildcard parameter of a path: `wildcard`, unless a `:wildcard` parameter exists. */
function wildcardName(fullPath: string): string {
  const names = new Set(
    fullPath
      .split('/')
      .filter(segment => segment.startsWith(':'))
      .map(segment => segment.slice(1)),
  )
  let name = 'wildcard'
  for (let index = 1; names.has(name); index++) name = `wildcard_${index}`
  return name
}

/** Names of the parameters of a path template, in order. */
function templateNames(template: string): string[] {
  return [...template.matchAll(/\{([^}]*)\}/g)].map(match => match[1] as string)
}

/**
 * OpenAPI forbids two templates of one path (`/books/{id}` and `/books/{bookId}`): the operations of
 * such a path are documented under one template (the first one, or the one a whole-path schema
 * names), with a ZNIGHT035 warning.
 */
function unifyPathTemplates(ctx: Context, operations: OperationModel[]): void {
  const groups = new Map<string, number[]>()
  operations.forEach((operation, index) => {
    const shape = operation.path.replace(/\{[^}]*\}/g, '{}')
    const group = groups.get(shape)
    if (group === undefined) groups.set(shape, [index])
    else group.push(index)
  })
  for (const indexes of groups.values()) {
    const group = indexes.map(index => operations[index] as OperationModel)
    const templates = [...new Set(group.map(operation => operation.path))].sort(compareStrings)
    if (templates.length < 2) continue
    const fixed = group.filter(hasPathPlaceholder).map(operation => operation.path)
    const canonical = [...fixed].sort(compareStrings)[0] ?? (templates[0] as string)
    const target = templateNames(canonical)
    const renamed: OperationModel[] = []
    for (const index of indexes) {
      const operation = operations[index] as OperationModel
      if (operation.path === canonical || hasPathPlaceholder(operation)) continue
      const names = new Map(templateNames(operation.path).map((name, position) => [name, target[position] as string]))
      for (const parameter of (operation.operation['parameters'] ?? []) as Json[]) {
        const name = parameter['name']
        if (parameter['in'] === 'path' && typeof name === 'string' && names.has(name)) {
          parameter['name'] = names.get(name)
        }
      }
      operations[index] = { ...operation, path: canonical }
      renamed.push(operation)
    }
    const first = renamed[0] ?? (group[0] as OperationModel)
    const kept = group.filter(operation => operation.path !== canonical && hasPathPlaceholder(operation))
    ctx.report({
      code: Codes.InconsistentOperation,
      severity: 'warning',
      message: `The routes of one path name its parameters differently (${group.map(operation => operation.label).join(', ')}): OpenAPI forbids two templates of one path, ${kept.length === 0 ? `documented as ${canonical}` : `the whole-path schemas keep ${kept.map(operation => operation.path).join(', ')}`}`,
      location: first.location,
      related: group
        .filter(operation => operation !== first)
        .map(operation => ({ message: operation.label, location: operation.location })),
      hints: ['Give the parameters the same names on every route of the path'],
    })
  }
}

/** Whether the path parameters of an operation come from a whole-path schema (`@Param(Schema)`). */
function hasPathPlaceholder(operation: OperationModel): boolean {
  return ((operation.operation['parameters'] ?? []) as Json[]).some(
    parameter => parameter['$znight'] === 'parameters' && parameter['in'] === 'path',
  )
}

function pathShape(fullPath: string): string {
  return fullPath
    .split('/')
    .map(segment => (segment.startsWith(':') ? ':' : segment))
    .join('/')
}

function owned(decorators: readonly DecoratorInfo[] | undefined): DecoratorInfo[] {
  return (decorators ?? []).filter(decorator => decorator.owner === EXTENSION_NAME)
}

function excluded(ctx: Context, decorators: readonly DecoratorInfo[], target: string): boolean {
  const exclude = decorators.find(decorator => decorator.identity === Ids.ApiExclude)
  if (exclude === undefined) return false
  const others = decorators.filter(decorator => decorator !== exclude)
  if (others.length > 0) {
    ctx.report({
      code: Codes.InconsistentOperation,
      severity: 'warning',
      message: `${target} is excluded from the OpenAPI document (@ApiExclude): ${others.map(decorator => `@${decorator.name}`).join(', ')} ${others.length > 1 ? 'have' : 'has'} no effect`,
      location: exclude.location,
      hints: ['Remove @ApiExclude to document it, or remove the other @Api* decorators'],
    })
  }
  return true
}

function tagsOf(ctx: Context, decorators: readonly DecoratorInfo[]): string[] {
  const tags: string[] = []
  for (const decorator of decorators.filter(candidate => candidate.identity === Ids.ApiTags)) {
    for (const arg of decorator.args) {
      if (typeof arg.value === 'string' && arg.value.trim() !== '') tags.push(arg.value)
      else invalidValue(ctx, arg, 'a tag must be a non-empty string')
    }
  }
  return [...new Set(tags)]
}

function invalidValue(
  ctx: Context,
  arg: ArgInfo | { readonly location: Location },
  message: string,
  hints: readonly string[] = [],
): void {
  ctx.report({ code: Codes.InvalidOpenApiDefinition, severity: 'error', message, location: arg.location, hints })
}

function checkDuplicateIds(ctx: Context, operations: readonly OperationModel[]): void {
  const byId = new Map<string, OperationModel>()
  for (const operation of operations) {
    const other = byId.get(operation.operationId)
    if (other === undefined) {
      byId.set(operation.operationId, operation)
      continue
    }
    ctx.report({
      code: Codes.DuplicateOperationId,
      severity: 'error',
      message: `Duplicate operation id "${operation.operationId}": ${other.label} and ${operation.label}`,
      location: operation.location,
      related: [{ message: 'the other operation', location: other.location }],
      hints: [`Rename one controller, or set an id: @ApiOperation({ operationId: '...' })`],
    })
  }
}

/** Everything one operation is built from. */
interface OperationSource {
  readonly controller: HttpControllerData
  readonly route: HttpRouteData
  readonly httpMethod: string
  readonly cls: ClassInfo | undefined
  readonly method: MethodInfo | undefined
  readonly classDecorators: readonly DecoratorInfo[]
  readonly methodDecorators: readonly DecoratorInfo[]
  readonly classTags: readonly string[]
  readonly defaultTag: string
}

/** The success response inferred from the handler. */
interface SuccessModel {
  readonly status: number
  /** The status is chosen at runtime (`HttpResponse`, `@Res()`): other 2xx statuses may be declared. */
  readonly dynamic: boolean
  /** The status of an empty response also returned (`Book | undefined` → 204). */
  readonly empty: number | undefined
  readonly content: Record<string, Json> | undefined
  readonly problem: string | undefined
  readonly hints: string[]
  readonly location: Location | undefined
}

/** Inferred or declared response of a status. */
interface ResponseDraft {
  description: string | undefined
  headers: Record<string, Json>
  content: Record<string, Json> | undefined
}

class OperationBuilder {
  readonly #input: OperationsInput
  readonly #ctx: Context
  readonly #source: OperationSource
  readonly #label: string
  readonly #location: Location
  readonly #doc: DocComment | undefined
  readonly #paramDocs: Map<string, string>
  readonly #strict: boolean

  constructor(input: OperationsInput, source: OperationSource) {
    this.#input = input
    this.#ctx = input.ctx
    this.#source = source
    this.#label = `${source.httpMethod} ${source.route.fullPath} (${source.controller.displayName}.${source.route.handler})`
    this.#location = source.method?.location ?? source.route.location
    this.#doc = input.document.jsdoc ? source.method?.doc : undefined
    this.#paramDocs = new Map()
    for (const tag of this.#doc?.tags ?? []) {
      if (tag.name !== 'param') continue
      const match = /^(?:\{[^}]*\}\s*)?\[?([\w$]+)[^\s]*\s*(?:-\s*)?([\s\S]*)$/.exec(tag.text)
      if (match?.[1] !== undefined && match[2] !== undefined && match[2].trim() !== '') {
        this.#paramDocs.set(match[1], match[2].trim())
      }
    }
    this.#strict = input.document.strict
  }

  build(): OperationModel {
    const { route, httpMethod, controller } = this.#source
    const method = httpMethod.toLowerCase()
    const options = this.#apiOperation()
    const operation: Json = {}
    const operationId = this.#operationId(options)
    operation['operationId'] = operationId
    const summary = stringOption(options, 'summary') ?? this.#doc?.summary
    const description = stringOption(options, 'description') ?? this.#doc?.description
    if (summary !== undefined) operation['summary'] = summary
    if (description !== undefined) operation['description'] = description
    const methodTags = tagsOf(this.#ctx, this.#source.methodDecorators)
    const tags = [...new Set([...this.#source.classTags, ...methodTags])]
    operation['tags'] = tags.length > 0 ? tags : [this.#source.defaultTag]
    const deprecated =
      typeof options?.['deprecated'] === 'boolean'
        ? options['deprecated']
        : this.#doc?.tags.some(tag => tag.name === 'deprecated') === true
    if (deprecated) operation['deprecated'] = true
    if (isRecord(options?.['externalDocs'])) operation['externalDocs'] = toJson(options['externalDocs'])
    const parameters = this.#parameters()
    if (parameters.length > 0) operation['parameters'] = parameters
    const body = this.#requestBody(httpMethod)
    if (body !== undefined) operation['requestBody'] = body
    operation['responses'] = this.#responses(httpMethod)
    const security = this.#security()
    if (security !== undefined) operation['security'] = security
    if (isRecord(options?.['extensions'])) {
      for (const [key, value] of Object.entries(options['extensions'])) {
        if (key.startsWith('x-')) operation[key] = toJson(value)
      }
    }
    if (route.fullPath.endsWith('/*')) operation['x-znight-wildcard'] = true
    return {
      controller: controller.token,
      handler: route.handler,
      route: route.method,
      method,
      path: pathTemplate(route.fullPath),
      operation,
      operationId,
      label: this.#label,
      location: this.#location,
    }
  }

  // ------------------------------------------------------------------------------------------------
  // identity and texts

  #apiOperation(): Readonly<Record<string, StaticValue>> | undefined {
    const decorator = this.#source.methodDecorators.find(candidate => candidate.identity === Ids.ApiOperation)
    const arg = decorator?.args[0]
    if (arg === undefined) return undefined
    if (!isRecord(arg.value)) {
      invalidValue(
        this.#ctx,
        arg,
        `@ApiOperation takes { summary?, description?, operationId?, deprecated?, externalDocs?, extensions? }, received ${describe(arg.value)}`,
      )
      return undefined
    }
    const reserved = findReservedKey(arg.value)
    if (reserved !== undefined) invalidValue(this.#ctx, arg, `"$znight" is a reserved key (${reserved})`)
    for (const key of Object.keys(arg.value)) {
      if (!['summary', 'description', 'operationId', 'deprecated', 'externalDocs', 'extensions'].includes(key)) {
        invalidValue(this.#ctx, arg, `@ApiOperation: unknown option "${key}"`)
      }
    }
    const extensions = arg.value['extensions']
    if (isRecord(extensions)) {
      for (const key of Object.keys(extensions)) {
        if (!key.startsWith('x-'))
          invalidValue(this.#ctx, arg, `@ApiOperation: the extension "${key}" must start with "x-"`)
      }
    }
    return arg.value
  }

  #operationId(options: Readonly<Record<string, StaticValue>> | undefined): string {
    const { controller, route, httpMethod } = this.#source
    const explicit = options?.['operationId']
    if (explicit !== undefined) {
      if (typeof explicit !== 'string' || !OPERATION_ID.test(explicit)) {
        const decorator = this.#source.methodDecorators.find(candidate => candidate.identity === Ids.ApiOperation)
        invalidValue(
          this.#ctx,
          decorator ?? { location: this.#location },
          `Invalid operation id ${describe(explicit)}: it must match ${String(OPERATION_ID)}`,
        )
      } else {
        return route.method === 'ALL' ? `${explicit}.${httpMethod.toLowerCase()}` : explicit
      }
    }
    const base = controller.displayName.replace(/Controller$/, '') || controller.displayName
    let id: string
    switch (this.#input.document.operationIds) {
      case 'handler':
        id = route.handler
        break
      case 'Controller_handler':
        id = `${controller.displayName}_${route.handler}`
        break
      default:
        id = `${base.charAt(0).toLowerCase()}${base.slice(1)}.${route.handler}`
    }
    if (route.method === 'ALL') id = `${id}.${httpMethod.toLowerCase()}`
    if (!OPERATION_ID.test(id)) id = id.replace(/[^\w.-]/g, '_').replace(/^[^A-Za-z_]/, '_')
    return id
  }

  #use(part: string, io: 'input' | 'output', location?: Location): SchemaUse {
    return { io, operation: this.#label, part, location: location ?? this.#location }
  }

  #paramInfo(data: HttpParamData): ParameterInfo | undefined {
    return this.#source.method?.params.find(param => param.index === data.index)
  }

  #paramDoc(data: HttpParamData): string | undefined {
    return this.#paramDocs.get(this.#paramInfo(data)?.name ?? data.name)
  }

  // ------------------------------------------------------------------------------------------------
  // parameters

  #parameters(): unknown[] {
    const { route } = this.#source
    const parameters: unknown[] = []
    const declared = new Set<string>()
    const params = route.params
    // path parameters, in path order
    const wholePath = params.find(
      param => param.source === 'param' && param.key === undefined && param.schema !== undefined,
    )
    if (wholePath?.schema === undefined) {
      for (const segment of route.fullPath.split('/')) {
        if (!segment.startsWith(':') && segment !== '*') continue
        const key = segment === '*' ? '*' : segment.slice(1)
        const data = params.find(param => param.source === 'param' && param.key === key)
        const parameter: Json = { name: key === '*' ? wildcardName(route.fullPath) : key, in: 'path' }
        const doc = data === undefined ? undefined : this.#paramDoc(data)
        if (doc !== undefined) parameter['description'] = doc
        else if (key === '*') parameter['description'] = 'The rest of the path, `/` included'
        parameter['required'] = true
        parameter['schema'] =
          data === undefined ? { type: 'string' } : this.#paramSchema(data, `path parameter "${key}"`)
        if (key === '*') parameter['x-znight-wildcard'] = true
        parameters.push(parameter)
        declared.add(`path ${parameter['name']}`)
      }
    } else {
      const name = this.#input.slots.use(wholePath.schema, 'input')?.name
      if (name !== undefined) parameters.push(placeholder('path', name))
    }
    for (const data of params) {
      if (data.source === 'query') this.#signatureParameter(data, 'query', parameters, declared)
      else if (data.source === 'headers') this.#signatureParameter(data, 'header', parameters, declared)
      else if (data.source === 'cookie' || data.source === 'signedCookie') {
        this.#signatureParameter(data, 'cookie', parameters, declared)
      }
    }
    const decorated = [
      ...this.#source.classDecorators.filter(decorator => decorator.identity === Ids.ApiHeader),
      ...this.#source.methodDecorators.filter(
        decorator => decorator.identity === Ids.ApiQuery || decorator.identity === Ids.ApiHeader,
      ),
    ]
    for (const decorator of decorated) {
      const parameter = this.#decoratedParameter(decorator, declared)
      if (parameter !== undefined) parameters.push(parameter)
    }
    return parameters
  }

  #signatureParameter(
    data: HttpParamData,
    location: 'query' | 'header' | 'cookie',
    parameters: unknown[],
    declared: Set<string>,
  ): void {
    if (data.key === undefined) {
      if (data.schema !== undefined) {
        const name = this.#input.slots.use(data.schema, 'input')?.name
        if (name !== undefined) parameters.push(placeholder(location, name))
        return
      }
      // `@Query() q: SearchParams`: one parameter per property of the type
      const info = this.#paramInfo(data)
      if (info === undefined || location !== 'query') return
      const result = this.#input.schemas.shape({ parameter: info })
      const use = this.#use(`the ${location} parameters`, 'input', info.typeLocation)
      this.#input.schemas.register(result, use)
      const object = this.#objectProperties(result.root)
      for (const property of object ?? []) {
        const parameter: Json = { name: property.name, in: location }
        if (property.description !== undefined) parameter['description'] = property.description
        if (!property.optional) parameter['required'] = true
        parameter['schema'] = this.#input.schemas.convert(property.shape, use, property.name)
        if (property.shape.kind === 'array') {
          parameter['style'] = 'form'
          parameter['explode'] = true
        }
        parameters.push(parameter)
        declared.add(`${location} ${property.name}`)
      }
      return
    }
    if (location === 'header' && IGNORED_HEADERS.has(data.key)) {
      this.#ctx.report({
        code: Codes.InconsistentOperation,
        severity: 'warning',
        message: `The "${data.key}" header of ${this.#label} is not documented as a parameter: OpenAPI ignores Accept, Content-Type and Authorization parameters`,
        location: data.location,
        hints: ['Describe credentials with a security scheme (securityScheme()) and @ApiSecurity or decisions'],
      })
      return
    }
    const parameter: Json = { name: data.key, in: location }
    const doc = this.#paramDoc(data)
    if (doc !== undefined) parameter['description'] = doc
    if (!data.optional) parameter['required'] = true
    parameter['schema'] = this.#paramSchema(data, `${location} parameter "${data.key}"`)
    if (location === 'query' && isArrayPlan(data.coercion?.plan)) {
      parameter['style'] = 'form'
      parameter['explode'] = true
    }
    parameters.push(parameter)
    declared.add(`${location} ${data.key}`)
  }

  #objectProperties(
    shape: Shape,
  ): { name: string; shape: Shape; optional: boolean; description: string | undefined }[] | undefined {
    if (shape.kind === 'named') {
      const named = this.#input.schemas.named(shape.key)
      return named === undefined ? undefined : this.#objectProperties(named.shape)
    }
    if (shape.kind !== 'object') return undefined
    return shape.properties.map(property => ({
      name: property.name,
      shape: property.shape,
      optional: property.optional,
      description: property.doc?.text === '' ? undefined : property.doc?.text,
    }))
  }

  #paramSchema(data: HttpParamData, part: string): SchemaTemplate {
    if (data.schema !== undefined) return this.#input.slots.use(data.schema, 'input') ?? {}
    const schema: Record<string, unknown> = data.coercion === undefined ? {} : { ...planSchema(data.coercion.plan) }
    if (data.defaultValue !== undefined) {
      const value = toJson(data.defaultValue)
      if (value !== undefined) schema['default'] = value
    }
    void part
    return schema as JsonSchema
  }

  #decoratedParameter(decorator: DecoratorInfo, declared: Set<string>): Json | undefined {
    const location = decorator.identity === Ids.ApiQuery ? 'query' : 'header'
    const [nameArg, optionsArg] = decorator.args
    const name = nameArg?.value
    if (typeof name !== 'string' || name === '') {
      invalidValue(this.#ctx, nameArg ?? decorator, `@${decorator.name} needs a parameter name`)
      return undefined
    }
    const key = location === 'header' ? name.toLowerCase() : name
    if (location === 'header' && !HEADER_NAME.test(name)) {
      invalidValue(this.#ctx, nameArg ?? decorator, `Invalid header name ${JSON.stringify(name)}`)
      return undefined
    }
    if (location === 'header' && IGNORED_HEADERS.has(key)) {
      this.#ctx.report({
        code: Codes.InconsistentOperation,
        severity: 'error',
        message: `@ApiHeader('${name}'): OpenAPI ignores Accept, Content-Type and Authorization parameters`,
        location: decorator.location,
        hints: ['Describe credentials with a security scheme: securityScheme() and @ApiSecurity'],
      })
      return undefined
    }
    if (declared.has(`${location} ${key}`)) {
      this.#ctx.report({
        code: Codes.InconsistentOperation,
        severity: 'error',
        message: `@${decorator.name}('${name}') documents the ${location} parameter "${key}" of ${this.#label}, which the signature already reads`,
        location: decorator.location,
        hints: [`Remove @${decorator.name}: the parameter is documented from the signature`],
      })
      return undefined
    }
    declared.add(`${location} ${key}`)
    const options = optionsArg?.value
    if (options !== undefined && !isRecord(options)) {
      invalidValue(
        this.#ctx,
        optionsArg ?? decorator,
        `@${decorator.name} options must be { description?, required?, deprecated?, example? }`,
      )
    }
    const record = isRecord(options) ? options : {}
    for (const option of Object.keys(record)) {
      if (!['description', 'required', 'deprecated', 'example'].includes(option)) {
        invalidValue(this.#ctx, optionsArg ?? decorator, `@${decorator.name}: unknown option "${option}"`)
      }
    }
    const parameter: Json = { name: key, in: location }
    if (typeof record['description'] === 'string') parameter['description'] = record['description']
    if (record['required'] === true) parameter['required'] = true
    if (record['deprecated'] === true) parameter['deprecated'] = true
    if (decorator.typeArgs.length > 0) {
      const result = this.#input.schemas.shape({ decorator, typeArgument: 0 })
      parameter['schema'] = this.#input.schemas.fromResult(
        result,
        this.#use(`the ${location} parameter "${key}"`, 'input', decorator.location),
      )
    } else {
      parameter['schema'] = { type: 'string' }
    }
    if (record['example'] !== undefined) parameter['example'] = toJson(record['example'])
    return parameter
  }

  // ------------------------------------------------------------------------------------------------
  // request body

  #requestBody(httpMethod: string): Json | undefined {
    const { route } = this.#source
    const body = route.params.find(param => param.source === 'body')
    const uploads = route.params.filter(param => param.upload !== undefined)
    const apiBody = this.#source.methodDecorators.find(decorator => decorator.identity === Ids.ApiBody)
    if (apiBody !== undefined && (httpMethod === 'GET' || httpMethod === 'HEAD')) {
      this.#ctx.report({
        code: Codes.InconsistentOperation,
        severity: 'warning',
        message: `@ApiBody on ${this.#label}: ${httpMethod} requests have no body in OpenAPI tools`,
        location: apiBody.location,
        hints: ['Use another method, or remove @ApiBody'],
      })
    }
    if (apiBody !== undefined && (body?.schema !== undefined || route.bodySchema !== undefined)) {
      this.#ctx.report({
        code: Codes.InconsistentOperation,
        severity: 'error',
        message: `@ApiBody on ${this.#label}, whose body is already documented by its schema`,
        location: apiBody.location,
        hints: ['Remove @ApiBody: the body schema documents the request'],
      })
      return this.#bodyFromSignature(body, uploads)
    }
    if (apiBody !== undefined && uploads.length === 0) return this.#declaredBody(apiBody, body)
    return this.#bodyFromSignature(body, uploads)
  }

  #bodyFromSignature(body: HttpParamData | undefined, uploads: readonly HttpParamData[]): Json | undefined {
    const { route } = this.#source
    if (uploads.length > 0) return this.#multipart(body, uploads)
    if (body !== undefined) {
      const request: Json = {}
      const doc = this.#paramDoc(body)
      if (doc !== undefined) request['description'] = doc
      let content: Json
      if (body.schema === undefined) {
        const info = this.#paramInfo(body)
        const result = info === undefined ? undefined : this.#input.schemas.shape({ parameter: info })
        const root = result?.root
        if (result === undefined || root === undefined) content = { 'application/json': { schema: {} } }
        else if (root.kind === 'string') content = { 'text/plain': { schema: { type: 'string' } } }
        else if (root.kind === 'binary') content = { 'application/octet-stream': {} }
        else {
          content = {
            'application/json': {
              schema: this.#input.schemas.fromResult(
                result,
                this.#use('the request body', 'input', info?.typeLocation),
              ),
            },
          }
        }
      } else {
        content = { 'application/json': { schema: this.#input.slots.use(body.schema, 'input') ?? {} } }
      }
      request['content'] = content
      if (!body.optional) request['required'] = true
      return request
    }
    if (route.bodySchema !== undefined) {
      return {
        content: { 'application/json': { schema: this.#input.slots.use(route.bodySchema, 'input') ?? {} } },
        required: true,
      }
    }
    return undefined
  }

  #multipart(form: HttpParamData | undefined, uploads: readonly HttpParamData[]): Json {
    const properties: Json = {}
    const required: string[] = []
    const encoding: Json = {}
    let additional: Json | undefined
    for (const param of uploads) {
      const upload = param.upload as UploadData
      const file: Json = { type: 'string', contentMediaType: 'application/octet-stream' }
      const doc = this.#paramDoc(param)
      const size =
        upload.maxSize === undefined || upload.maxSize === Number.POSITIVE_INFINITY ? undefined : upload.maxSize
      const descriptions = [doc, size === undefined ? undefined : `At most ${formatSize(size)}`].filter(
        text => text !== undefined,
      )
      if (descriptions.length > 0) file['description'] = descriptions.join('. ')
      if (size !== undefined) file['x-znight-max-size'] = size
      const schema: Json = upload.multiple
        ? {
            type: 'array',
            items: file,
            ...(upload.maxFiles === undefined || upload.maxFiles === Number.POSITIVE_INFINITY
              ? {}
              : { maxItems: upload.maxFiles }),
          }
        : file
      if (upload.field === undefined) {
        additional = schema
        continue
      }
      properties[upload.field] = schema
      if (upload.required) required.push(upload.field)
      if (upload.mimeTypes !== undefined && upload.mimeTypes.length > 0) {
        encoding[upload.field] = { contentType: upload.mimeTypes.join(', ') }
      }
    }
    const files: Json = { type: 'object' }
    if (Object.keys(properties).length > 0) files['properties'] = properties
    if (required.length > 0) files['required'] = required.sort(compareStrings)
    if (additional !== undefined) files['additionalProperties'] = additional
    const textFields = form?.schema === undefined ? undefined : this.#input.slots.use(form.schema, 'input')
    const media: Json = { schema: textFields === undefined ? files : { allOf: [textFields, files] } }
    if (Object.keys(encoding).length > 0) media['encoding'] = encoding
    const request: Json = { content: { 'multipart/form-data': media } }
    if (required.length > 0 || (form !== undefined && !form.optional)) request['required'] = true
    return request
  }

  #declaredBody(decorator: DecoratorInfo, body: HttpParamData | undefined): Json | undefined {
    void body
    const arg = decorator.args[0]
    const options = arg?.value
    if (options !== undefined && !isRecord(options)) {
      invalidValue(
        this.#ctx,
        arg ?? decorator,
        '@ApiBody options must be { description?, required?, contentType?, schema? }',
      )
      return undefined
    }
    const record = isRecord(options) ? options : {}
    for (const key of Object.keys(record)) {
      if (!['description', 'required', 'contentType', 'schema'].includes(key)) {
        invalidValue(this.#ctx, arg ?? decorator, `@ApiBody: unknown option "${key}"`)
      }
    }
    const contentTypes = this.#mediaTypes(record['contentType'], arg ?? decorator) ?? ['application/json']
    let schema: SchemaTemplate | undefined
    const schemaOption = record['schema']
    if (isRef(schemaOption)) schema = this.#input.slots.use(schemaOption, 'input')
    else if (schemaOption !== undefined)
      invalidValue(this.#ctx, arg ?? decorator, '@ApiBody schema must be a Standard Schema (an exported schema)')
    else if (decorator.typeArgs.length > 0) {
      const result = this.#input.schemas.shape({ decorator, typeArgument: 0 })
      schema = this.#input.schemas.fromResult(result, this.#use('the request body', 'input', decorator.location))
    }
    const content: Json = {}
    for (const type of contentTypes) {
      content[type] = schema === undefined ? defaultMedia(type) : { schema }
    }
    const request: Json = {}
    if (typeof record['description'] === 'string') request['description'] = record['description']
    request['content'] = content
    if (record['required'] !== false) request['required'] = true
    return request
  }

  #mediaTypes(value: StaticValue, where: ArgInfo | DecoratorInfo): string[] | undefined {
    if (value === undefined) return undefined
    let list: readonly StaticValue[] | undefined
    if (typeof value === 'string') list = [value]
    else if (Array.isArray(value)) list = value as readonly StaticValue[]
    if (
      list === undefined ||
      list.length === 0 ||
      list.some(item => typeof item !== 'string' || !MEDIA_TYPE.test(item))
    ) {
      invalidValue(this.#ctx, where, `Invalid media type ${describe(value)}: expected "type/subtype" or a list of them`)
      return undefined
    }
    return list as string[]
  }

  // ------------------------------------------------------------------------------------------------
  // responses

  #responses(httpMethod: string): Json {
    const { route, method } = this.#source
    const errors = this.#input.document.errors
    const declared = this.#source.methodDecorators.filter(decorator => decorator.identity === Ids.ApiResponse)
    const declaredStatuses = declared
      .map(decorator => decorator.args[0]?.value)
      .map(status => (typeof status === 'number' ? String(status) : status))
    const success = this.#success(httpMethod)
    const responses = new Map<string, ResponseDraft>()
    const covered =
      declaredStatuses.includes(String(success.status)) ||
      declaredStatuses.includes('2XX') ||
      (success.dynamic && declaredStatuses.some(status => typeof status === 'string' && /^2\d\d$/.test(status)))
    if (success.problem !== undefined && !covered) {
      this.#ctx.report({
        code: Codes.UndocumentedResponse,
        severity: this.#strict ? 'error' : 'warning',
        message: `The ${success.status} response of ${this.#label} cannot be documented: ${success.problem}`,
        location: success.location ?? this.#location,
        hints: success.hints,
      })
    }
    const returns = this.#doc?.tags.find(tag => tag.name === 'returns' || tag.name === 'return')?.text
    if (success.problem === undefined || !covered) {
      const headers: Record<string, Json> = {}
      for (const [name, value] of route.headers) {
        headers[name] = { schema: { type: 'string' }, example: value }
      }
      responses.set(String(success.status), {
        description: returns !== undefined && returns !== '' ? returns : undefined,
        headers,
        content: success.content,
      })
      if (success.empty !== undefined) {
        responses.set(String(success.empty), { description: undefined, headers: { ...headers }, content: undefined })
      }
    }
    for (const decorator of declared) this.#declaredResponse(decorator, responses, success)
    // standard errors
    const result: Json = {}
    const reads =
      route.params.some(param => param.source === 'body' || param.upload !== undefined) ||
      route.bodySchema !== undefined
    const validates =
      reads ||
      route.params.some(
        param => param.schema !== undefined || (param.coercion !== undefined && param.coercion.plan.kind !== 'raw'),
      )
    const uploads = route.params.some(param => param.upload !== undefined)
    if (errors !== false) {
      const standard = (status: string, name: string): void => {
        if (!responses.has(status)) result[status] = { $ref: `#/components/responses/${name}` }
      }
      if (validates) standard('400', ERROR_RESPONSES.badRequest)
      if (reads) standard('413', ERROR_RESPONSES.payloadTooLarge)
      if (uploads) standard('415', ERROR_RESPONSES.unsupportedMediaType)
    }
    for (const [status, draft] of responses) {
      const response: Json = { description: draft.description ?? reasonPhrase(status) }
      if (Object.keys(draft.headers).length > 0) response['headers'] = draft.headers
      let content = draft.content
      if (content === undefined && errors !== false && /^[45]/.test(status)) {
        const schema =
          errors.schema === undefined
            ? { $ref: schemaRef(ERROR_COMPONENTS.body) }
            : (this.#input.slots.use(errors.schema, 'output') ?? {})
        content = { [errors.contentType]: { schema } }
      }
      if (content !== undefined) response['content'] = content
      result[status] = response
    }
    void method
    const sorted: Json = {}
    for (const status of Object.keys(result).sort(compareStatuses)) sorted[status] = result[status]
    return sorted
  }

  #success(httpMethod: string): SuccessModel {
    const { route, method } = this.#source
    const post = httpMethod === 'POST'
    const statusFor = (empty: boolean): number => {
      if (route.status !== undefined) return route.status
      if (post) return 201
      return empty ? 204 : 200
    }
    const undocumentable = (problem: string, hints: string[], dynamic = false): SuccessModel => ({
      status: statusFor(false),
      dynamic,
      empty: undefined,
      content: undefined,
      problem,
      hints,
      location: method?.location,
    })
    if (route.sse !== undefined) return this.#sse()
    if (route.rawResponse) {
      return undocumentable(
        'the handler writes the response itself (@Res())',
        [`Declare it: @ApiResponse<Body>(${statusFor(false)})`],
        true,
      )
    }
    if (method?.returnType === undefined) {
      return undocumentable('the handler has no return type annotation', [
        `Annotate the return type: ${method?.async === true ? 'Promise<Body>' : 'Body'}`,
        `Or declare it: @ApiResponse<Body>(${statusFor(false)})`,
      ])
    }
    const result = this.#input.schemas.shape({ returnOf: method })
    const use = this.#use('the response', 'output')
    this.#input.schemas.register(result, use)
    // `HttpResponse<T>` members are documented as `T`, their status is chosen at runtime
    let dynamic = false
    let returnsUndefined = false
    const bodies: Shape[] = []
    for (const member of unionMembers(result.root)) {
      if (member.kind === 'reference' && member.identity === HttpIds.HttpResponse) {
        dynamic = true
        const body = member.typeArgs[0]
        if (member.explicitTypeArgs === 0 || body === undefined) {
          return undocumentable(
            'HttpResponse has no body type',
            [
              'Give the body type: Promise<HttpResponse<BookResponse>>',
              `Or declare it: @ApiResponse<BookResponse>(${statusFor(false)})`,
            ],
            true,
          )
        }
        bodies.push(...unionMembers(body))
      } else {
        if (member.kind === 'undefined') returnsUndefined = true
        bodies.push(member)
      }
    }
    const defined = distinct(bodies.filter(member => member.kind !== 'undefined' && member.kind !== 'never'))
    if (defined.some(member => member.kind === 'reference' && member.identity === 'globalThis#Response')) {
      return undocumentable(
        'a Web Response has no body type',
        [`Declare it: @ApiResponse<Body>(${statusFor(false)})`],
        true,
      )
    }
    if (defined.some(member => member.kind === 'unknown')) {
      return undocumentable(
        `the return type is ${method.returnType.kind === 'primitive' ? method.returnType.name : 'unknown'}`,
        ['Give a precise return type', `Or declare it: @ApiResponse<Body>(${statusFor(false)})`],
        dynamic,
      )
    }
    if (defined.length === 0) {
      return {
        status: statusFor(true),
        dynamic,
        empty: undefined,
        content: undefined,
        problem: undefined,
        hints: [],
        location: undefined,
      }
    }
    const events = defined.filter(member => member.kind === 'reference' && member.identity === HttpIds.SseBody)
    if (events.length > 0) {
      // HttpResponse.sse(): 200 (even on POST) unless @HttpCode, text/event-stream
      if (events.length < defined.length) {
        return undocumentable(
          'the handler returns an event stream or another body',
          [`Declare the responses: @ApiResponse(${route.status ?? 200}, { contentType: 'text/event-stream' })`],
          true,
        )
      }
      return {
        status: route.status ?? 200,
        dynamic: true,
        empty: undefined,
        content: httpMethod === 'HEAD' ? undefined : { 'text/event-stream': { schema: { type: 'string' } } },
        problem: undefined,
        hints: [],
        location: undefined,
      }
    }
    const status = statusFor(false)
    let content: Record<string, Json> | undefined = this.#successContent(defined, use)
    if (content !== undefined && isBodylessStatus(status)) {
      this.#ctx.report({
        code: Codes.InconsistentOperation,
        severity: 'error',
        message: `${this.#label} returns a body, but its status is always ${status} (@HttpCode(${status})): ${status} responses have none, the body is never sent`,
        location: method.location,
        hints: ['Return nothing (void), or use another status'],
      })
      content = undefined
    }
    return {
      status,
      dynamic,
      // a plain `undefined` is sent as an empty 204 (not on POST routes, not with @HttpCode)
      empty: returnsUndefined && route.status === undefined && !post && status !== 204 ? 204 : undefined,
      // HEAD responses never have a body
      content: httpMethod === 'HEAD' ? undefined : content,
      problem: undefined,
      hints: [],
      location: undefined,
    }
  }

  /** Content of the success response: media types of the serialiser (§9.1 of the architecture). */
  #successContent(members: readonly Shape[], use: SchemaUse): Record<string, Json> | undefined {
    const single = members.length === 1 ? (members[0] as Shape) : undefined
    if (single !== undefined) {
      if (single.kind === 'binary' || (single.kind === 'reference' && single.identity === HttpIds.FileBody)) {
        return { 'application/octet-stream': {} }
      }
      if (single.kind === 'reference' && single.identity === 'globalThis#AsyncIterable') {
        const event = single.typeArgs[0]
        const data = event?.kind === 'reference' && event.identity === HttpIds.SseEvent ? event.typeArgs[0] : event
        const media: Json = { schema: { type: 'string' } }
        if (data !== undefined) media['x-znight-event-schema'] = this.#input.schemas.convert(data, use, '')
        return { 'text/event-stream': media }
      }
    }
    // strings are sent as text/plain, everything else as JSON
    const text: Shape[] = []
    const json: Shape[] = []
    for (const member of members) this.#splitText(member, text, json, new Set())
    const schemaOf = (shapes: Shape[]): SchemaTemplate =>
      this.#input.schemas.convert(
        shapes.length === 1 ? (shapes[0] as Shape) : { kind: 'union', members: shapes },
        use,
        '',
      )
    const content: Record<string, Json> = {}
    if (json.length > 0) content['application/json'] = { schema: schemaOf(json) }
    if (text.length > 0) content['text/plain'] = { schema: schemaOf(text) }
    return content
  }

  /**
   * Sorts the members of a body by the media type the serialiser gives them: strings (string, string
   * literals, string enums) are text, the rest JSON. A named declaration stays whole when all its
   * members go to one side.
   */
  #splitText(shape: Shape, text: Shape[], json: Shape[], seen: Set<string>): void {
    const kind = this.#textKind(shape, new Set(seen))
    if (kind === 'text') text.push(shape)
    else if (kind === 'json') json.push(shape)
    else if (shape.kind === 'union') {
      for (const member of shape.members) this.#splitText(member, text, json, seen)
    } else if (shape.kind === 'named') {
      const named = this.#input.schemas.named(shape.key)
      if (named === undefined || seen.has(shape.key)) json.push(shape)
      else this.#splitText(named.shape, text, json, new Set([...seen, shape.key]))
    } else {
      json.push(shape)
    }
  }

  #textKind(shape: Shape, seen: Set<string>): 'text' | 'json' | 'mixed' {
    switch (shape.kind) {
      case 'string':
        return 'text'
      case 'literal':
        return typeof shape.value === 'string' ? 'text' : 'json'
      case 'union': {
        const kinds = new Set(shape.members.map(member => this.#textKind(member, seen)))
        return kinds.size === 1 ? ([...kinds][0] as 'text' | 'json' | 'mixed') : 'mixed'
      }
      case 'intersection':
        // branded strings (`string & { readonly brand: unique symbol }`)
        return shape.members.some(member => this.#textKind(member, seen) === 'text') ? 'text' : 'json'
      case 'named': {
        const named = this.#input.schemas.named(shape.key)
        if (named === undefined || seen.has(shape.key)) return 'json'
        seen.add(shape.key)
        return this.#textKind(named.shape, seen)
      }
      default:
        return 'json'
    }
  }

  /** `@Sse` routes: a 200 event stream; the type of the events' `data` when the return type tells it. */
  #sse(): SuccessModel {
    const { method } = this.#source
    const media: Json = { schema: { type: 'string' } }
    if (method?.returnType !== undefined) {
      const result = this.#input.schemas.shape({ returnOf: method })
      const use = this.#use('the events', 'output')
      this.#input.schemas.register(result, use)
      const data = eventData(result.root)
      if (data !== undefined) media['x-znight-event-schema'] = this.#input.schemas.convert(data, use, '')
    }
    return {
      status: 200,
      dynamic: true,
      empty: undefined,
      content: { 'text/event-stream': media },
      problem: undefined,
      hints: [],
      location: undefined,
    }
  }

  #declaredResponse(decorator: DecoratorInfo, responses: Map<string, ResponseDraft>, success: SuccessModel): void {
    const [statusArg, optionsArg] = decorator.args
    const raw = statusArg?.value
    const status = typeof raw === 'number' ? String(raw) : raw
    if (typeof status !== 'string' || !isResponseStatus(status)) {
      invalidValue(
        this.#ctx,
        statusArg ?? decorator,
        `Invalid response status ${describe(raw)}: expected a code (100-599), "2XX"-like or "default"`,
      )
      return
    }
    const options = optionsArg?.value
    if (options !== undefined && !isRecord(options)) {
      invalidValue(
        this.#ctx,
        optionsArg ?? decorator,
        '@ApiResponse options must be { description?, schema?, contentType?, headers?, example? }',
      )
      return
    }
    const record = isRecord(options) ? options : {}
    for (const key of Object.keys(record)) {
      if (!['description', 'schema', 'contentType', 'headers', 'example'].includes(key)) {
        invalidValue(this.#ctx, optionsArg ?? decorator, `@ApiResponse: unknown option "${key}"`)
      }
    }
    const reserved = findReservedKey(record)
    if (reserved !== undefined)
      invalidValue(this.#ctx, optionsArg ?? decorator, `"$znight" is a reserved key (${reserved})`)
    const code = Number(status)
    if (Number.isInteger(code) && code >= 200 && code < 300 && code !== success.status && code !== success.empty) {
      const fixed = this.#source.route.status !== undefined || !success.dynamic
      if (fixed) {
        this.#ctx.report({
          code: Codes.InconsistentOperation,
          severity: 'error',
          message: `@ApiResponse(${status}) on ${this.#label}, whose success status is always ${success.status}`,
          location: decorator.location,
          hints: [
            this.#source.route.status === undefined
              ? `Return an HttpResponse to choose the status, or document ${success.status}`
              : `@HttpCode(${this.#source.route.status}) sets the status: document ${this.#source.route.status}`,
          ],
        })
        return
      }
    }
    let schema: SchemaTemplate | undefined
    const schemaOption = record['schema']
    if (isRef(schemaOption)) schema = this.#input.slots.use(schemaOption, 'output')
    else if (schemaOption !== undefined)
      invalidValue(
        this.#ctx,
        optionsArg ?? decorator,
        '@ApiResponse schema must be a Standard Schema (an exported schema)',
      )
    else if (decorator.typeArgs.length > 0) {
      const result = this.#input.schemas.shape({ decorator, typeArgument: 0 })
      schema = this.#input.schemas.fromResult(result, this.#use(`the ${status} response`, 'output', decorator.location))
    }
    if (schema !== undefined && (status === '204' || status === '304')) {
      this.#ctx.report({
        code: Codes.InconsistentOperation,
        severity: 'error',
        message: `@ApiResponse(${status}) on ${this.#label} declares a body: ${status} responses have none`,
        location: decorator.location,
        hints: ['Remove the body type, or use another status'],
      })
      schema = undefined
    }
    const contentTypes = this.#mediaTypes(record['contentType'], optionsArg ?? decorator)
    const draft = responses.get(status) ?? { description: undefined, headers: {}, content: undefined }
    if (typeof record['description'] === 'string') draft.description = record['description']
    const headers = record['headers']
    if (headers !== undefined) {
      if (isRecord(headers)) {
        for (const [name, header] of Object.entries(headers)) {
          if (!HEADER_NAME.test(name)) {
            invalidValue(this.#ctx, optionsArg ?? decorator, `Invalid header name ${JSON.stringify(name)}`)
            continue
          }
          const json = toJson(header)
          const object = isRecord(json) ? (json as Json) : {}
          draft.headers[name.toLowerCase()] = {
            ...draft.headers[name.toLowerCase()],
            ...object,
            schema: object['schema'] ?? { type: 'string' },
          }
        }
      } else
        invalidValue(
          this.#ctx,
          optionsArg ?? decorator,
          '@ApiResponse headers must be { [name]: { description?, schema?, ... } }',
        )
    }
    const example = record['example'] === undefined ? undefined : toJson(record['example'])
    if (schema !== undefined || contentTypes !== undefined) {
      const previous = draft.content === undefined ? undefined : Object.values(draft.content)[0]
      const types = contentTypes ?? (schema === undefined ? [] : ['application/json'])
      const content: Record<string, Json> = {}
      for (const type of types) {
        const media: Json = {}
        const mediaSchema = schema ?? (previous?.['schema'] as SchemaTemplate | undefined)
        if (mediaSchema !== undefined) media['schema'] = mediaSchema
        if (example !== undefined) media['example'] = example
        content[type] = media
      }
      draft.content = content
    } else if (example !== undefined && draft.content !== undefined) {
      for (const media of Object.values(draft.content)) media['example'] = example
    }
    responses.set(status, draft)
  }

  // ------------------------------------------------------------------------------------------------
  // security

  #security(): SecurityRequirementObject[] | undefined {
    const { schemes } = this.#input
    for (const decorators of [this.#source.methodDecorators, this.#source.classDecorators]) {
      const decorator = decorators.find(candidate => candidate.identity === Ids.ApiSecurity)
      if (decorator === undefined) continue
      const requirements: RequirementModel[] = []
      for (const arg of decorator.args) {
        const requirement = schemes.requirement(arg.ref ?? arg.value, arg.location)
        if (requirement !== undefined) requirements.push(requirement)
      }
      return schemes.objects(requirements)
    }
    const decisions = this.#input.document.decisions
    if (decisions.length === 0) return undefined
    const { route, controller } = this.#source
    const routeGroups = new Set(route.meta.map(entry => entry.group))
    const inherited = controller.meta.filter(entry => !routeGroups.has(entry.group))
    for (const entries of [route.meta, inherited]) {
      for (const decision of decisions) {
        const entry = entries.find(candidate => candidate.identity === decision.identity)
        if (entry === undefined) continue
        decision.used = true
        return this.#decisionSecurity(decision, entry)
      }
    }
    return undefined
  }

  #decisionSecurity(decision: DecisionModel, entry: MetaEntry): SecurityRequirementObject[] | undefined {
    const { schemes } = this.#input
    if (!decision.scopesFromValue) return schemes.objects(decision.security)
    const value = entry.value
    if (!Array.isArray(value) || !(value as readonly StaticValue[]).every(item => typeof item === 'string')) {
      this.#ctx.report({
        code: Codes.InvalidSecurityRequirement,
        severity: 'error',
        message: `The decision on ${decision.text} takes its scopes from the decorator value, but @${entry.decorator}(...) on ${this.#label} is not a static string array`,
        location: entry.location,
        hints: [`Write the scopes literally: @${entry.decorator}(['admin'])`],
      })
      return schemes.objects(decision.security)
    }
    const scopes = value as readonly string[]
    for (const requirement of decision.security) {
      for (const { scheme } of requirement) {
        if (!scheme.scoped) {
          this.#ctx.report({
            code: Codes.InvalidSecurityRequirement,
            severity: 'error',
            message: `The decision on ${decision.text} gives scopes to "${scheme.name}" (${String(scheme.definition.type)}): scopes are only allowed on oauth2 and openIdConnect schemes`,
            location: decision.location,
            hints: ["Remove scopes: 'value', or use an oauth2 scheme"],
          })
          return schemes.objects(decision.security)
        }
        const unknown = scheme.scopes === undefined ? [] : scopes.filter(scope => !scheme.scopes?.has(scope))
        if (unknown.length > 0) {
          this.#ctx.report({
            code: Codes.InvalidSecurityRequirement,
            severity: 'error',
            message: `@${entry.decorator}(${JSON.stringify(scopes)}) on ${this.#label} uses ${unknown.length > 1 ? 'scopes' : 'a scope'} that "${scheme.name}" does not declare: ${unknown.join(', ')}`,
            location: entry.location,
            related: [{ message: 'the security scheme', location: scheme.location }],
            hints: [`Declare the scope in the flows of ${scheme.name}, or fix the decorator value`],
          })
        }
      }
    }
    return schemes.objects(decision.security, scopes)
  }
}

/** A media type without declared schema: text is a string, bytes have no schema, anything else is any value. */
function defaultMedia(type: string): Json {
  if (type.startsWith('text/')) return { schema: { type: 'string' } }
  return type === 'application/octet-stream' ? {} : { schema: {} }
}

function stringOption(options: Readonly<Record<string, StaticValue>> | undefined, key: string): string | undefined {
  const value = options?.[key]
  return typeof value === 'string' ? value : undefined
}

function placeholder(location: ParametersPlaceholder['in'], name: string): ParametersPlaceholder {
  return { $znight: 'parameters', in: location, name, io: 'input' }
}

function isArrayPlan(plan: CoercionPlan | undefined): boolean {
  if (plan === undefined) return false
  if (plan.kind === 'optional') return isArrayPlan(plan.item)
  return plan.kind === 'array'
}

/** The members of a union (the shape itself otherwise). */
function unionMembers(shape: Shape): readonly Shape[] {
  return shape.kind === 'union' ? shape.members : [shape]
}

/** The shapes without repetitions (`Book | HttpResponse<Book>` documents `Book` once). */
function distinct(shapes: readonly Shape[]): Shape[] {
  const seen = new Set<string>()
  return shapes.filter(shape => {
    let key: string
    try {
      key = JSON.stringify(shape)
    } catch {
      return true
    }
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Statuses whose responses have no body: the serialiser drops it (204, 304, 1xx). */
function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200)
}

/** The `T` of `SseEvent<T>` found in a stream type (`AsyncIterable<SseEvent<T>> | HttpResponse`). */
function eventData(shape: Shape): Shape | undefined {
  if (shape.kind === 'reference') {
    if (shape.identity === HttpIds.SseEvent) return shape.typeArgs[0]
    for (const arg of shape.typeArgs) {
      const found = eventData(arg)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (shape.kind === 'union') {
    for (const member of shape.members) {
      const found = eventData(member)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** JSON Schema of a coercion plan (§5.4.2). */
export function planSchema(plan: CoercionPlan): JsonSchema {
  switch (plan.kind) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      return { type: plan.kind }
    case 'bigint':
      return { type: 'string', pattern: '^-?[0-9]+$' }
    case 'date':
      return { type: 'string', format: 'date-time' }
    case 'enum': {
      const types = [...new Set(plan.values.map(value => typeof value))]
      return types.length === 1 ? { type: types[0] as string, enum: [...plan.values] } : { enum: [...plan.values] }
    }
    case 'array':
      return { type: 'array', items: planSchema(plan.item) as JsonValue }
    case 'optional':
      return planSchema(plan.item)
    case 'raw':
      return {}
  }
}

/** `2 MiB`, `512 KiB`, `1000 bytes`. */
export function formatSize(bytes: number): string {
  const units = ['GiB', 'MiB', 'KiB'] as const
  const factors = [1024 ** 3, 1024 ** 2, 1024]
  for (const [index, unit] of units.entries()) {
    const factor = factors[index] as number
    if (bytes >= factor && bytes % (factor / 4) === 0) return `${bytes / factor} ${unit}`
  }
  return `${bytes} bytes`
}

/** Status keys: codes first in numeric order, then ranges, then `default`. */
function compareStatuses(a: string, b: string): number {
  const rank = (status: string): number => {
    if (status === 'default') return 2
    return /X/.test(status) ? 1 : 0
  }
  return rank(a) - rank(b) || compareStrings(a, b)
}
