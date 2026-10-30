/**
 * The HTTP applications under test. Each serves the same two routes with the same controller ->
 * service -> repository chain (see benchmarks/README.md):
 *
 * - `GET /users/:id`: the id parsed as an integer, a user read from an in-memory map, JSON;
 * - `POST /users`: a JSON body validated with the same Zod 4 schema, a user created, `201` and JSON.
 */
import { join } from 'node:path'

export type Framework = 'znight' | 'nestjs' | 'baseline'
export type Adapter = 'node' | 'fastify' | 'express' | 'hono'
export type Runtime = 'node' | 'bun'

export interface Variant {
  /** `znight-fastify`, `nestjs-express`, `baseline-hono`... */
  readonly id: string
  readonly framework: Framework
  readonly adapter: Adapter
  /** Application directory (`benchmarks/apps/<framework>`). */
  readonly dir: string
  /** Built entry, relative to `dir`. */
  readonly entry: string
  /** Environment selecting the adapter. */
  readonly env: Readonly<Record<string, string>>
}

export const APPS_DIR: string = join(import.meta.dir, '../apps')

export const FRAMEWORK_NAMES: Readonly<Record<Framework, string>> = {
  znight: 'Znight',
  nestjs: 'NestJS',
  baseline: 'Hand-wired',
}

export const ADAPTER_NAMES: Readonly<Record<Adapter, string>> = {
  node: 'node:http',
  fastify: 'Fastify',
  express: 'Express',
  hono: 'Hono',
}

export const RUNTIME_NAMES: Readonly<Record<Runtime, string>> = { node: 'Node.js', bun: 'Bun' }

function znight(adapter: Adapter): Variant {
  return {
    id: `znight-${adapter}`,
    framework: 'znight',
    adapter,
    dir: join(APPS_DIR, 'znight'),
    entry: 'dist/main.js',
    env: { ADAPTER: adapter },
  }
}

function nestjs(adapter: 'fastify' | 'express'): Variant {
  return {
    id: `nestjs-${adapter}`,
    framework: 'nestjs',
    adapter,
    dir: join(APPS_DIR, 'nestjs'),
    entry: 'dist/main.js',
    env: { PLATFORM: adapter },
  }
}

function baseline(adapter: Adapter): Variant {
  return {
    id: `baseline-${adapter}`,
    framework: 'baseline',
    adapter,
    dir: join(APPS_DIR, 'baseline'),
    entry: `dist/${adapter}.js`,
    env: {},
  }
}

/** Grouped by adapter: the hand-wired baseline, Znight, then NestJS when it supports the adapter. */
export const VARIANTS: readonly Variant[] = [
  baseline('fastify'),
  znight('fastify'),
  nestjs('fastify'),
  baseline('express'),
  znight('express'),
  nestjs('express'),
  baseline('node'),
  znight('node'),
  baseline('hono'),
  znight('hono'),
]

export function variantLabel(variant: Variant): string {
  return `${FRAMEWORK_NAMES[variant.framework]} (${ADAPTER_NAMES[variant.adapter]})`
}
