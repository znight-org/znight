/**
 * `OpenApiPlugin` (§5.6, §8 of RFC 0002): serves the document (`/openapi.json`, optional YAML) and
 * the API reference UI through the plugin routes of `@znight/http`, and provides the `OpenApi`
 * external.
 */
import type {
  Container,
  CoreLogger,
  Plugin,
  PluginContext,
  PluginOptions,
  PluginRootsContext,
  ProviderKey,
  ZnightMetadata,
} from '@znight/core'
import type {
  GuardRef,
  HttpContext,
  HttpPlugin,
  PluginHttpRoutes,
  PluginHttpRoutesContext,
  PluginRoute,
  RouteMetaEntry,
} from '@znight/http'
import type { BuildOpenApiOptions, OpenApiOperationView } from './build.ts'
import type { SchemaConverter } from './converters.ts'
import type { InfoObject, JsonValue, OpenApiObject, ServerObject } from './types.ts'
import type { LocalPackage, UiKind } from './ui.ts'

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ErrorCode, resolveOptions, ZnightError } from '@znight/core'
import { HttpResponse, NotFoundException } from '@znight/http'

import { buildOpenApiDocument, openApiSection, operationViews } from './build.ts'
import { OpenApi, OpenApiTokens, toYaml } from './openapi.ts'
import { findLocalPackage, renderUiPage, UI_PACKAGES } from './ui.ts'

/** The UI option: a kind, or a kind with its JSON-serialisable configuration. */
export type OpenApiUiOption =
  | UiKind
  | false
  | { readonly scalar: Readonly<Record<string, JsonValue>> }
  | { readonly swagger: Readonly<Record<string, JsonValue>> }

/** Options of {@link OpenApiPlugin.configure}. */
export interface OpenApiPluginOptions {
  /** `false` serves nothing and builds nothing (the `OpenApi` external still works). Default `true`. */
  readonly enabled?: boolean
  /** Path of the JSON document, relative to the HTTP prefix. Default `'/openapi.json'`. */
  readonly path?: string
  /** A path (`'/openapi.yaml'`) also serves YAML (`application/yaml`, optional peer `yaml`). Default `false`. */
  readonly yaml?: string | false
  /** `'scalar'` (default), `'swagger'`, `false`, or `{ scalar: config }` / `{ swagger: config }`. */
  readonly ui?: OpenApiUiOption
  /** Path of the UI page. Local assets are under `${uiPath}/_assets/`. Default `'/docs'`. */
  readonly uiPath?: string
  /**
   * `'local'` serves the UI package from `node_modules`, `'cdn'` the jsDelivr copy pinned by this
   * release (with SRI), `'auto'` (default) local when the package is installed.
   */
  readonly assets?: 'auto' | 'local' | 'cdn'
  /** `'build'` (default) assembles the document from the metadata; `{ file }` serves a prebuilt `openapi.json`. */
  readonly document?: 'build' | { readonly file: string | URL }
  /** `'boot'` (default): built in `onBootstrap` (a failure fails the boot); `'first-request'`: built lazily. */
  readonly build?: 'boot' | 'first-request'
  /** Merged over the static `info`. */
  readonly info?: Partial<InfoObject>
  /** Replaces the declared `servers`. */
  readonly servers?: readonly ServerObject[]
  readonly filter?: (operation: OpenApiOperationView) => boolean
  readonly transform?: (document: OpenApiObject) => OpenApiObject
  /** Extra converters, tried before the built-in ones. */
  readonly converters?: readonly SchemaConverter[]
  /** `'warn'`: a schema that cannot be converted becomes `{}` (ZNIGHT037 warning). Default `'error'`. */
  readonly unrepresentable?: 'error' | 'warn'
  /** Route metadata of the docs routes (`[Public.meta()]`): seen by guards and by the route decision check. */
  readonly meta?: readonly RouteMetaEntry[]
  /** Extra guards of the docs routes (classes or instances), after the global guards. */
  readonly guards?: readonly GuardRef[]
  /** `cache-control` of the document (revalidated with the ETag). Default `'no-cache'`. */
  readonly cacheControl?: string
}

interface Resolved {
  readonly enabled: boolean
  readonly path: string
  readonly yaml: string | undefined
  readonly ui: { readonly kind: UiKind; readonly config: Readonly<Record<string, JsonValue>> } | undefined
  readonly uiPath: string
  readonly assets: 'auto' | 'local' | 'cdn'
  readonly file: string | undefined
  readonly lazy: boolean
  readonly build: BuildOpenApiOptions
  readonly meta: readonly RouteMetaEntry[]
  readonly guards: readonly GuardRef[]
  readonly cacheControl: string
}

/** A precomputed response body. */
interface Body {
  readonly bytes: Uint8Array
  readonly etag: string
  readonly contentType: string
}

/** Everything served, computed once. */
interface Served {
  readonly document: OpenApiObject
  readonly json: Body
  readonly yaml: Body | undefined
}

const ENCODER = new TextEncoder()
const ASSET_CACHE = 'public, max-age=31536000, immutable'
const PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/]*$/

/** The OpenAPI plugin: `OpenApiPlugin.configure()` (name `openapi`). */
export class OpenApiPlugin implements Plugin, PluginHttpRoutes {
  readonly name = 'openapi'
  readonly #options: PluginOptions<OpenApiPluginOptions>
  #resolved: Resolved | undefined
  #container: Container | undefined
  #metadata: ZnightMetadata | undefined
  #logger: CoreLogger | undefined
  #http: HttpPlugin | undefined
  #served: Served | undefined
  #building: Promise<Served> | undefined
  #ui: { html: Uint8Array; csp: string; etag: string } | undefined
  #local: LocalPackage | undefined
  #operations: readonly OpenApiOperationView[] = []
  #active = false

  private constructor(options: PluginOptions<OpenApiPluginOptions>) {
    this.#options = options
  }

  /**
   * Creates the plugin. `options` may be a function of the container, evaluated once the container
   * is ready: `OpenApiPlugin.configure(c => ({ enabled: c.get(ServerConfig).docs }))`.
   */
  static configure(options: PluginOptions<OpenApiPluginOptions> = {}): OpenApiPlugin {
    return new OpenApiPlugin(options)
  }

  /** The classes of the `guards` option (instances are left out): `TestApp` creates them at boot. */
  initRoots(_context?: PluginRootsContext): readonly ProviderKey[] {
    const options: unknown = this.#options
    if (options === null || typeof options !== 'object') return []
    try {
      const guards: unknown = (options as OpenApiPluginOptions).guards
      return Array.isArray(guards) ? guards.filter((guard): guard is ProviderKey => typeof guard === 'function') : []
    } catch {
      return []
    }
  }

  register(ctx: PluginContext): void {
    if (this.#active) {
      throw new ZnightError(ErrorCode.DuplicateProvider, 'This OpenApiPlugin is already used by another application', {
        hints: ['Call OpenApiPlugin.configure() once per application'],
      })
    }
    openApiSection(ctx.metadata)
    if (ctx.getPlugin('http') === undefined) {
      throw new ZnightError(
        ErrorCode.InvalidOpenApiDefinition,
        'OpenApiPlugin serves its routes through HttpPlugin, which is not registered',
        {
          hints: ['Add HttpPlugin.configure() to the plugins of the application'],
        },
      )
    }
    this.#active = true
    this.#resolved = undefined
    this.#served = undefined
    this.#building = undefined
    this.#ui = undefined
    this.#local = undefined
    this.#container = ctx.container
    this.#metadata = ctx.metadata
    this.#logger = ctx.logger
    this.#http = ctx.getPlugin<HttpPlugin>('http')
    this.#operations = operationViews(ctx.metadata)
    ctx.container.registerValue(OpenApiTokens.OpenApi, new OpenApiService(this))
  }

  httpRoutes(context: PluginHttpRoutesContext): readonly PluginRoute[] {
    this.#container ??= context.container
    const options = this.#resolve()
    if (!options.enabled) return []
    const common = {
      ...(options.meta.length > 0 ? { meta: options.meta } : {}),
      ...(options.guards.length > 0 ? { guards: options.guards } : {}),
    }
    const routes: PluginRoute[] = [
      {
        method: 'GET',
        path: options.path,
        name: 'document',
        handler: ctx => this.#serveDocument(ctx, 'json'),
        ...common,
      },
    ]
    if (options.yaml !== undefined) {
      routes.push({
        method: 'GET',
        path: options.yaml,
        name: 'yaml',
        handler: ctx => this.#serveDocument(ctx, 'yaml'),
        ...common,
      })
    }
    if (options.ui !== undefined) {
      routes.push({
        method: 'GET',
        path: options.uiPath,
        name: 'ui',
        handler: ctx => this.#serveUi(ctx, context.prefix),
        ...common,
      })
      if (this.#localPackage(options) !== undefined) {
        routes.push({
          method: 'GET',
          path: `${options.uiPath === '/' ? '' : options.uiPath}/_assets/*`,
          name: 'assets',
          handler: ctx => this.#serveAsset(ctx),
          ...common,
        })
      }
    }
    return routes
  }

  async onBootstrap(ctx: PluginContext): Promise<void> {
    this.#container = ctx.container
    const options = this.#resolve()
    if (!options.enabled) return
    this.#checkServers(options)
    if (options.lazy && options.file === undefined) return
    await this.served()
  }

  onReady(ctx: PluginContext): void {
    const options = this.#resolved
    const address = this.#http?.address
    if (options === undefined || !options.enabled || options.ui === undefined || address === undefined) return
    ctx.logger.info(`API reference: ${String(address.url).replace(/\/$/, '')}${this.#prefix()}${options.uiPath}`)
  }

  onDispose(): void {
    this.#active = false
    this.#served = undefined
    this.#building = undefined
    this.#ui = undefined
    this.#resolved = undefined
  }

  /** The views of the operations (no schema conversion). */
  get operations(): readonly OpenApiOperationView[] {
    return this.#operations
  }

  /** The served document and bodies, built once (shared promise; a failure is retried on the next call). */
  served(): Promise<Served> {
    if (this.#served !== undefined) return Promise.resolve(this.#served)
    if (this.#building === undefined) {
      this.#building = this.#build().then(
        served => {
          this.#served = served
          return served
        },
        (error: unknown) => {
          this.#building = undefined
          throw error
        },
      )
    }
    return this.#building
  }

  async #build(): Promise<Served> {
    const options = this.#resolve()
    const metadata = this.#metadata
    if (metadata === undefined) {
      throw new ZnightError(
        ErrorCode.LifecycleFailed,
        'OpenApiPlugin: the document is only available once the plugin is registered',
      )
    }
    let document: OpenApiObject
    let json: string
    if (options.file === undefined) {
      const result = await buildOpenApiDocument(metadata, { ...options.build, prefix: this.#prefix() })
      for (const warning of result.warnings) this.#logger?.warn(`${warning.code}: ${warning.message}`)
      this.#logger?.debug('OpenAPI document built', {
        operations: result.stats.operations,
        schemas: result.stats.schemas,
        ms: Math.round(result.stats.durationMs * 100) / 100,
      })
      document = result.document
      json = result.json
    } else {
      json = await readFile(options.file, 'utf8')
      document = parseDocumentFile(json, options.file)
      const expected = openApiSection(metadata).fingerprint
      const actual = (document as { 'x-znight-fingerprint'?: unknown })['x-znight-fingerprint']
      if (actual !== expected) {
        this.#logger?.warn(
          `ZNIGHT030: ${options.file} is stale: it was not emitted from this build of the application (x-znight-fingerprint differs)`,
          { hints: ['Regenerate it: znight openapi (or znight build --openapi)'] },
        )
      }
    }
    const yaml = options.yaml === undefined ? undefined : body(await toYaml(document), 'application/yaml')
    return { document, json: body(json, 'application/json; charset=utf-8'), yaml }
  }

  // ------------------------------------------------------------------------------------------------
  // handlers

  async #serveDocument(ctx: HttpContext, format: 'json' | 'yaml'): Promise<HttpResponse<Uint8Array | undefined>> {
    const options = this.#resolve()
    let served: Served
    try {
      served = await this.served()
    } catch (error) {
      this.#logger?.error('OpenApiPlugin: the document cannot be built', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const selected = format === 'json' ? served.json : served.yaml
    if (selected === undefined) throw new NotFoundException()
    return conditional(ctx, selected, options.cacheControl)
  }

  async #serveUi(ctx: HttpContext, prefix: string): Promise<HttpResponse<Uint8Array | undefined>> {
    const options = this.#resolve()
    if (this.#ui === undefined) {
      const ui = options.ui
      if (ui === undefined) throw new NotFoundException()
      const served = options.lazy ? undefined : await this.served()
      const document = served?.document
      const local = this.#localPackage(options)
      const base = prefix === '/' ? '' : prefix
      const uiPath = options.uiPath === '/' ? '' : options.uiPath
      const page = renderUiPage({
        kind: ui.kind,
        documentUrl: `${base}${options.path}`,
        assetsBase: local === undefined ? undefined : `${base}${uiPath}/_assets/${ui.kind}@${local.version}`,
        title: document?.info.title === undefined ? 'API reference' : `${document.info.title} — API reference`,
        config: ui.config,
        connect: serverOrigins(document?.servers ?? options.build.servers ?? []),
      })
      const bytes = ENCODER.encode(page.html)
      this.#ui = { html: bytes, csp: page.csp, etag: etagOf(bytes) }
    }
    const page = this.#ui
    const response = conditional(
      ctx,
      { bytes: page.html, etag: page.etag, contentType: 'text/html; charset=utf-8' },
      'no-cache',
    )
    return response.withHeader('content-security-policy', page.csp).withHeader('x-content-type-options', 'nosniff')
  }

  #serveAsset(ctx: HttpContext): HttpResponse {
    const options = this.#resolve()
    const ui = options.ui
    const local = this.#localPackage(options)
    if (ui === undefined || local === undefined) throw new NotFoundException()
    const requested = ctx.params['*'] ?? ''
    const prefix = `${ui.kind}@${local.version}/`
    const asset = requested.startsWith(prefix)
      ? UI_PACKAGES[ui.kind].assets.find(
          candidate =>
            candidate.file.endsWith(`/${requested.slice(prefix.length)}`) ||
            candidate.file === requested.slice(prefix.length),
        )
      : undefined
    if (asset === undefined) throw new NotFoundException()
    return HttpResponse.file(asset.file, { root: local.dir }).withHeader('cache-control', ASSET_CACHE)
  }

  // ------------------------------------------------------------------------------------------------
  // options

  #localPackage(options: Resolved): LocalPackage | undefined {
    if (options.ui === undefined || options.assets === 'cdn') return undefined
    if (this.#local === undefined) {
      this.#local = findLocalPackage(UI_PACKAGES[options.ui.kind])
      if (this.#local === undefined && options.assets === 'local') {
        throw new ZnightError(
          ErrorCode.InvalidOpenApiDefinition,
          `OpenApiPlugin: assets: 'local' needs ${UI_PACKAGES[options.ui.kind].name}, which is not installed`,
          {
            hints: [`npm install ${UI_PACKAGES[options.ui.kind].name}`, "Or serve the pinned CDN copy: assets: 'cdn'"],
          },
        )
      }
    }
    return this.#local
  }

  #prefix(): string {
    try {
      return this.#http?.prefix ?? ''
    } catch {
      return ''
    }
  }

  #checkServers(options: Resolved): void {
    const prefix = this.#prefix()
    if (prefix === '' || options.file !== undefined) return
    const metadata = this.#metadata
    const declared =
      options.build.servers ?? (metadata === undefined ? undefined : openApiSection(metadata).document.servers)
    for (const server of declared ?? []) {
      if (server.url.startsWith('/') && !server.url.replace(/\/$/, '').endsWith(prefix)) {
        this.#logger?.warn(
          `ZNIGHT030: the OpenAPI server "${server.url}" does not end with the HTTP prefix "${prefix}": generated clients would call the wrong paths`,
        )
      }
    }
  }

  #resolve(): Resolved {
    if (this.#resolved !== undefined) return this.#resolved
    let raw: OpenApiPluginOptions
    if (typeof this.#options === 'function') {
      const container = this.#container
      if (container === undefined) {
        throw new ZnightError(
          ErrorCode.LifecycleFailed,
          'OpenApiPlugin: its options are a function of the container, which is not ready',
        )
      }
      raw = resolveOptions(this.#options, container)
    } else {
      raw = this.#options
    }
    this.#resolved = resolvePluginOptions(raw)
    return this.#resolved
  }
}

/** Implementation of the {@link OpenApi} external. */
class OpenApiService extends OpenApi {
  readonly #plugin: OpenApiPlugin

  constructor(plugin: OpenApiPlugin) {
    super()
    this.#plugin = plugin
  }

  get operations(): readonly OpenApiOperationView[] {
    return this.#plugin.operations
  }

  async document(): Promise<OpenApiObject> {
    return (await this.#plugin.served()).document
  }

  async json(): Promise<string> {
    return new TextDecoder().decode((await this.#plugin.served()).json.bytes)
  }

  async yaml(): Promise<string> {
    const served = await this.#plugin.served()
    return served.yaml === undefined ? toYaml(served.document) : new TextDecoder().decode(served.yaml.bytes)
  }
}

function body(text: string, contentType: string): Body {
  const bytes = ENCODER.encode(text)
  return { bytes, etag: etagOf(bytes), contentType }
}

/** Strong ETag: base64url SHA-256, 27 characters. */
function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`
}

function conditional(ctx: HttpContext, served: Body, cacheControl: string): HttpResponse<Uint8Array | undefined> {
  const headers = { etag: served.etag, 'cache-control': cacheControl }
  if (matches(ctx.header('if-none-match'), served.etag))
    return new HttpResponse<Uint8Array | undefined>(undefined, { status: 304, headers })
  return new HttpResponse<Uint8Array | undefined>(served.bytes, {
    status: 200,
    headers: { ...headers, 'content-type': served.contentType },
  })
}

function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  return header.split(',').some(candidate => {
    const tag = candidate.trim()
    return tag === '*' || tag === etag || tag === `W/${etag}`
  })
}

/** Origins of the absolute server URLs (`connect-src` of the UI). */
function serverOrigins(servers: readonly ServerObject[]): string[] {
  const origins = new Set<string>()
  for (const server of servers) {
    try {
      const url = new URL(server.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin)
    } catch {
      // relative server: 'self'
    }
  }
  return [...origins].sort()
}

function parseDocumentFile(text: string, file: string): OpenApiObject {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new ZnightError(ErrorCode.InvalidOpenApiDefinition, `OpenApiPlugin: ${file} is not valid JSON`, {
      cause: error,
    })
  }
  const version = (document as { openapi?: unknown } | null)?.openapi
  if (typeof version !== 'string' || !version.startsWith('3.1.')) {
    throw new ZnightError(ErrorCode.InvalidOpenApiDefinition, `OpenApiPlugin: ${file} is not an OpenAPI 3.1 document`, {
      hints: ['Emit it with znight openapi (or znight build --openapi)'],
    })
  }
  return deepFreeze(document as OpenApiObject)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

function invalid(option: string, expected: string, value: unknown): ZnightError {
  let shown: string
  try {
    shown = typeof value === 'function' ? 'a function' : (JSON.stringify(value) ?? String(value))
  } catch {
    shown = typeof value
  }
  return new ZnightError(
    ErrorCode.InvalidOpenApiDefinition,
    `Invalid OpenApiPlugin option "${option}": expected ${expected}, received ${shown}`,
  )
}

const OPTION_KEYS = new Set([
  'enabled',
  'path',
  'yaml',
  'ui',
  'uiPath',
  'assets',
  'document',
  'build',
  'info',
  'servers',
  'filter',
  'transform',
  'converters',
  'unrepresentable',
  'meta',
  'guards',
  'cacheControl',
])

/** Checks and defaults the options (ZNIGHT030). */
export function resolvePluginOptions(options: OpenApiPluginOptions): Resolved {
  if (options === null || typeof options !== 'object') throw invalid('options', 'an object', options)
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw invalid(key, `one of ${[...OPTION_KEYS].join(', ')} (unknown option)`, key)
  }
  const enabled = options.enabled ?? true
  if (typeof enabled !== 'boolean') throw invalid('enabled', 'true or false', enabled)
  const route = (key: 'path' | 'uiPath', fallback: string): string => {
    const value = options[key] ?? fallback
    if (
      typeof value !== 'string' ||
      !PATH.test(value) ||
      value.includes('//') ||
      (value.length > 1 && value.endsWith('/'))
    ) {
      throw invalid(key, "a static path starting with '/' ('/openapi.json')", value)
    }
    return value
  }
  const path = route('path', '/openapi.json')
  const uiPath = route('uiPath', '/docs')
  const yamlOption = options.yaml ?? false
  if (yamlOption !== false && (typeof yamlOption !== 'string' || !PATH.test(yamlOption))) {
    throw invalid('yaml', "false or a path ('/openapi.yaml')", yamlOption)
  }
  const yaml = yamlOption === false ? undefined : yamlOption
  const uiOption = options.ui ?? 'scalar'
  let ui: Resolved['ui']
  if (uiOption === 'scalar' || uiOption === 'swagger') ui = { kind: uiOption, config: {} }
  else if (uiOption === false) ui = undefined
  else if (typeof uiOption === 'object' && uiOption !== null && Object.keys(uiOption).length === 1) {
    const kind = Object.keys(uiOption)[0] as UiKind
    const config = (uiOption as Record<string, unknown>)[kind]
    if ((kind !== 'scalar' && kind !== 'swagger') || typeof config !== 'object' || config === null || !isJson(config)) {
      throw invalid(
        'ui',
        "'scalar', 'swagger', false, { scalar: config } or { swagger: config } (JSON config)",
        uiOption,
      )
    }
    ui = { kind, config: config as Readonly<Record<string, JsonValue>> }
  } else throw invalid('ui', "'scalar', 'swagger', false, { scalar: config } or { swagger: config }", uiOption)
  const used = [path, ...(yaml === undefined ? [] : [yaml]), ...(ui === undefined ? [] : [uiPath])]
  if (new Set(used).size !== used.length)
    throw invalid('path', 'distinct paths for the document, the YAML and the UI', used)
  const assets = options.assets ?? 'auto'
  if (assets !== 'auto' && assets !== 'local' && assets !== 'cdn')
    throw invalid('assets', "'auto', 'local' or 'cdn'", assets)
  const documentOption = options.document ?? 'build'
  let file: string | undefined
  if (documentOption !== 'build') {
    const target = (documentOption as { file?: unknown } | null)?.file
    if (typeof target === 'string' && target !== '') file = target
    else if (target instanceof URL) file = fileURLToPath(target)
    else throw invalid('document', "'build' or { file: string | URL }", documentOption)
  }
  const build = options.build ?? 'boot'
  if (build !== 'boot' && build !== 'first-request') throw invalid('build', "'boot' or 'first-request'", build)
  for (const key of ['filter', 'transform'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'function') throw invalid(key, 'a function', options[key])
  }
  if (options.converters !== undefined) {
    if (
      !Array.isArray(options.converters) ||
      options.converters.some(converter => typeof converter?.convert !== 'function')
    ) {
      throw invalid('converters', 'an array of { name, convert(schema, context) }', options.converters)
    }
  }
  if (
    options.unrepresentable !== undefined &&
    options.unrepresentable !== 'error' &&
    options.unrepresentable !== 'warn'
  ) {
    throw invalid('unrepresentable', "'error' or 'warn'", options.unrepresentable)
  }
  if (options.info !== undefined && (typeof options.info !== 'object' || options.info === null))
    throw invalid('info', 'an object', options.info)
  if (
    options.servers !== undefined &&
    (!Array.isArray(options.servers) || options.servers.some(server => typeof server?.url !== 'string'))
  ) {
    throw invalid('servers', 'an array of { url, description? }', options.servers)
  }
  const meta = options.meta ?? []
  if (!Array.isArray(meta)) throw invalid('meta', 'an array of route metadata entries (Public.meta())', meta)
  const guards = options.guards ?? []
  if (!Array.isArray(guards)) throw invalid('guards', 'an array of guards (classes or instances)', guards)
  const cacheControl = options.cacheControl ?? 'no-cache'
  if (typeof cacheControl !== 'string' || cacheControl === '')
    throw invalid('cacheControl', 'a cache-control value', cacheControl)
  const buildOptions: BuildOpenApiOptions = {
    ...(options.info === undefined ? {} : { info: options.info }),
    ...(options.servers === undefined ? {} : { servers: options.servers }),
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(options.transform === undefined ? {} : { transform: options.transform }),
    ...(options.converters === undefined ? {} : { converters: options.converters }),
    ...(options.unrepresentable === undefined ? {} : { unrepresentable: options.unrepresentable }),
  }
  return {
    enabled,
    path,
    yaml,
    ui,
    uiPath,
    assets,
    file,
    lazy: build === 'first-request',
    build: buildOptions,
    meta,
    guards,
    cacheControl,
  }
}

function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJson)
  }
  return false
}
