/** Choices of `znight new`. */

/** Package managers supported by `znight new`. */
export type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn'

/** HTTP adapters of `@znight/http`. */
export type HttpAdapterName = 'node' | 'fastify' | 'express' | 'hono'

/** Optional features of a new project. */
export type Feature = 'config' | 'observability' | 'messaging' | 'schedule' | 'openapi' | 'graphql' | 'websocket'

/**
 * API reference UI of the `openapi` feature: `'scalar'` or `'swagger'` (the `ui` option of
 * `OpenApiPlugin`), or `'none'` (no `ui` option: `/openapi.json` only).
 */
export type OpenApiUiName = 'scalar' | 'swagger' | 'none'

/** Every package manager, in display order. */
export const PACKAGE_MANAGERS: readonly PackageManager[] = ['bun', 'npm', 'pnpm', 'yarn']

/** Every HTTP adapter, in display order (the default first). */
export const HTTP_ADAPTERS: readonly HttpAdapterName[] = ['fastify', 'node', 'express', 'hono']

/** HTTP adapter used when none is given. */
export const DEFAULT_ADAPTER: HttpAdapterName = 'fastify'

/** Every feature, in display (and canonical) order. */
export const FEATURES: readonly Feature[] = [
  'config',
  'observability',
  'messaging',
  'schedule',
  'openapi',
  'graphql',
  'websocket',
]

/** Every OpenAPI reference UI, in display order (the default first). */
export const OPENAPI_UIS: readonly OpenApiUiName[] = ['scalar', 'swagger', 'none']

/** OpenAPI reference UI used when none is given. */
export const DEFAULT_OPENAPI_UI: OpenApiUiName = 'scalar'

/** Features selected when none are given. */
export const DEFAULT_FEATURES: readonly Feature[] = ['config', 'observability']

/** Labels shown by the prompts and the help. */
export const ADAPTER_LABELS: Readonly<Record<HttpAdapterName, string>> = {
  fastify: 'Fastify',
  node: 'node:http (built-in, zero dependency)',
  express: 'Express',
  hono: 'Hono',
}

/** Labels shown by the prompts. */
export const FEATURE_LABELS: Readonly<Record<Feature, string>> = {
  config: 'Config: type-safe configuration classes (@znight/config)',
  observability: 'Observability: structured logs, metrics, tracing (@znight/observability)',
  messaging: 'Messaging: message consumers and publishing (@znight/messaging)',
  schedule: 'Schedule: cron, interval and timeout jobs (@znight/schedule)',
  openapi: 'OpenAPI: openapi.json and an optional API reference at /docs (@znight/openapi)',
  graphql: 'GraphQL: code-first schema derived from the TypeScript types (@znight/graphql)',
  websocket: 'WebSocket: gateways served on the HTTP port (@znight/websocket)',
}

/** Labels shown by the prompts. */
export const OPENAPI_UI_LABELS: Readonly<Record<OpenApiUiName, string>> = {
  scalar: 'Scalar',
  swagger: 'Swagger UI',
  none: 'No UI (openapi.json only)',
}

/** Everything that determines the files of a new project. */
export interface ProjectOptions {
  /** npm package name. */
  readonly name: string
  readonly packageManager: PackageManager
  readonly adapter: HttpAdapterName
  /** Selected features, in canonical order. */
  readonly features: readonly Feature[]
  /** API reference UI served at `/docs` with the `openapi` feature (`'none'`: no UI). Default: `'scalar'`. */
  readonly openapiUi?: OpenApiUiName
  /** Generate a multi-stage `Dockerfile` and a `.dockerignore`. Default: `true`. */
  readonly docker?: boolean
  /** Version range base of the `@znight/*` packages (the CLI version). */
  readonly znightVersion: string
}

/**
 * Parses `--features` (`config,observability`, `none`, `all`). Returns the features in canonical
 * order, or the unknown names.
 */
export function parseFeatures(value: string): { features: Feature[] } | { unknown: string[] } {
  const names = value
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(name => name !== '')
  if (names.length === 1 && names[0] === 'none') return { features: [] }
  if (names.length === 1 && names[0] === 'all') return { features: [...FEATURES] }
  const unknown = names.filter(name => !FEATURES.includes(name as Feature))
  if (unknown.length > 0) return { unknown }
  return { features: FEATURES.filter(feature => names.includes(feature)) }
}

/**
 * Default package manager: the one that launched the CLI (`npm_config_user_agent`: `pnpm dlx`,
 * `yarn dlx`, `bunx`, `npx`), else Bun when running on Bun, else npm.
 */
export function detectPackageManager(
  env: Readonly<Record<string, string | undefined>>,
  runningOnBun: boolean,
): PackageManager {
  const agent = env['npm_config_user_agent'] ?? ''
  const name = agent.split('/')[0]
  if (name === 'bun' || name === 'npm' || name === 'pnpm' || name === 'yarn') return name
  return runningOnBun ? 'bun' : 'npm'
}

/** `bun install`, `npm install`... */
export function installCommand(pm: PackageManager): readonly [string, ...string[]] {
  return [pm, 'install']
}

/** `bun run dev`, `npm run dev`, `pnpm dev`, `yarn dev`. */
export function runScript(pm: PackageManager, script: string): string {
  return pm === 'pnpm' || pm === 'yarn' ? `${pm} ${script}` : `${pm} run ${script}`
}

/** Runs a binary of the project: `npx znight`, `bunx znight`, `pnpm znight`, `yarn znight`. */
export function execBinary(pm: PackageManager, binary: string): string {
  switch (pm) {
    case 'npm':
      return `npx ${binary}`
    case 'bun':
      return `bunx ${binary}`
    default:
      return `${pm} ${binary}`
  }
}
