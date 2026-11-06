/**
 * The GraphQL applications under test. Each serves the same schema at `POST /graphql` (JSON body,
 * `200` and `application/json`), with the same resolver -> service -> in-memory repository chain,
 * `Book.author` batched by a DataLoader (one `users.findMany()` per request) and `createUser`
 * validated by the Zod 4 schema of the HTTP applications (see benchmarks/README.md). All of them
 * run on the same copy of graphql-js 17 (`graphqlSuite` checks it).
 */
import type { Runtime } from './variants.ts'

import { join } from 'node:path'

import { APPS_DIR } from './variants.ts'

export type GraphqlFramework = 'baseline' | 'yoga' | 'znight' | 'nestjs'

export interface GraphqlVariant {
  /** `baseline-graphql`, `znight-graphql-fastify`... */
  readonly id: string
  readonly framework: GraphqlFramework
  /** The HTTP server, as shown in the charts and tables (`node:http`, `Fastify`). */
  readonly server: string
  /** The name of the application in the charts and tables (`Znight + Yoga driver`). */
  readonly label: string
  /** Application directory (`benchmarks/apps/<name>-graphql`). */
  readonly dir: string
  /** Built entry, relative to `dir`. */
  readonly entry: string
  /** Environment selecting the server and the driver. */
  readonly env: Readonly<Record<string, string>>
  /** Runtimes the application does not run on, and why (published with the results). */
  readonly unsupported?: Readonly<Partial<Record<Runtime, string>>>
}

export const GRAPHQL_ENDPOINT = '/graphql'

/** The first group of the charts: GraphQL servers without an application framework. */
const STANDALONE = 'No framework'

export const GRAPHQL_FRAMEWORK_NAMES: Readonly<Record<GraphqlFramework, string>> = {
  baseline: 'graphql-js',
  yoga: 'GraphQL Yoga',
  znight: 'Znight',
  nestjs: 'NestJS',
}

/** Grouped by HTTP server: the standalone servers, then Znight and NestJS on each server. */
export const GRAPHQL_VARIANTS: readonly GraphqlVariant[] = [
  {
    id: 'baseline-graphql',
    framework: 'baseline',
    server: STANDALONE,
    label: 'graphql-js on node:http',
    dir: join(APPS_DIR, 'baseline-graphql'),
    entry: 'dist/graphql-js.js',
    env: {},
  },
  {
    id: 'yoga',
    framework: 'yoga',
    server: STANDALONE,
    label: 'GraphQL Yoga',
    dir: join(APPS_DIR, 'baseline-graphql'),
    entry: 'dist/yoga.js',
    env: {},
  },
  {
    id: 'znight-graphql-node',
    framework: 'znight',
    server: 'node:http',
    label: 'Znight',
    dir: join(APPS_DIR, 'znight-graphql'),
    entry: 'dist/main.js',
    env: { ADAPTER: 'node', GRAPHQL_DRIVER: 'builtin' },
  },
  {
    id: 'znight-graphql-yoga',
    framework: 'znight',
    server: 'node:http',
    label: 'Znight + Yoga driver',
    dir: join(APPS_DIR, 'znight-graphql'),
    entry: 'dist/main.js',
    env: { ADAPTER: 'node', GRAPHQL_DRIVER: 'yoga' },
  },
  {
    id: 'znight-graphql-fastify',
    framework: 'znight',
    server: 'Fastify',
    label: 'Znight',
    dir: join(APPS_DIR, 'znight-graphql'),
    entry: 'dist/main.js',
    env: { ADAPTER: 'fastify', GRAPHQL_DRIVER: 'builtin' },
  },
  {
    id: 'nestjs-graphql-fastify',
    framework: 'nestjs',
    server: 'Fastify',
    label: 'NestJS + Yoga',
    dir: join(APPS_DIR, 'nestjs-graphql'),
    entry: 'dist/main.js',
    env: { PLATFORM: 'fastify' },
  },
  {
    id: 'nestjs-graphql-express',
    framework: 'nestjs',
    server: 'Express',
    label: 'NestJS + Yoga',
    dir: join(APPS_DIR, 'nestjs-graphql'),
    entry: 'dist/main.js',
    env: { PLATFORM: 'express' },
  },
]

/** `Znight + Yoga driver (node:http)`, `GraphQL Yoga`. */
export function graphqlVariantLabel(variant: GraphqlVariant): string {
  return variant.server === STANDALONE ? variant.label : `${variant.label} (${variant.server})`
}

/** Why `variant` does not run on `runtime`, or `undefined` when it does. */
export function unsupportedReason(variant: GraphqlVariant, runtime: Runtime): string | undefined {
  return variant.unsupported?.[runtime]
}
