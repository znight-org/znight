/** The machine, the runtimes and the package versions of a run. */
import type { Environment } from './results.ts'

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'

import { runtimeVersion } from './process.ts'

const ROOT = join(import.meta.dir, '..')

/** A package whose version is recorded, and the workspace that installs it. */
export type RecordedPackage = readonly [name: string, workspace: string]

/** Packages of the boot, HTTP and dependency injection suites. */
const PACKAGES: readonly RecordedPackage[] = [
  ['@znight/core', 'apps/znight'],
  ['@znight/http', 'apps/znight'],
  ['@znight/compiler', 'apps/znight'],
  ['@nestjs/core', 'apps/nestjs'],
  ['@nestjs/platform-fastify', 'apps/nestjs'],
  ['@nestjs/platform-express', 'apps/nestjs'],
  ['fastify', 'apps/baseline'],
  ['express', 'apps/baseline'],
  ['hono', 'apps/baseline'],
  ['@hono/node-server', 'apps/baseline'],
  ['zod', 'apps/baseline'],
  ['tsyringe', '.'],
  ['inversify', '.'],
  ['reflect-metadata', '.'],
  ['autocannon', '.'],
  ['typescript', '.'],
  ['vite', 'apps/znight'],
]

/** Packages of the GraphQL suite. */
export const GRAPHQL_PACKAGES: readonly RecordedPackage[] = [
  ['graphql', 'apps/baseline-graphql'],
  ['graphql-yoga', 'apps/baseline-graphql'],
  ['dataloader', 'apps/baseline-graphql'],
  ['@znight/graphql', 'apps/znight-graphql'],
  ['@znight/http', 'apps/znight-graphql'],
  ['fastify', 'apps/znight-graphql'],
  ['@nestjs/core', 'apps/nestjs-graphql'],
  ['@nestjs/graphql', 'apps/nestjs-graphql'],
  ['@graphql-yoga/nestjs', 'apps/nestjs-graphql'],
  ['@nestjs/platform-fastify', 'apps/nestjs-graphql'],
  ['@nestjs/platform-express', 'apps/nestjs-graphql'],
  ['zod', 'apps/baseline-graphql'],
  ['autocannon', '.'],
]

function packageVersion(name: string, workspace: string): string {
  const manifest = join(ROOT, workspace, 'node_modules', name, 'package.json')
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
}

function run(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function operatingSystem(): string {
  if (platform() === 'darwin') return `macOS ${run('sw_vers', ['-productVersion'])}`
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(run('cat', ['/etc/os-release']))?.[1]
  return pretty ?? `${platform()} ${release()}`
}

export function environment(packages: readonly RecordedPackage[] = PACKAGES): Environment {
  return {
    date: new Date().toISOString(),
    commit: run('git', ['rev-parse', '--short', 'HEAD']),
    machine: cpus()[0]?.model.trim() ?? 'unknown',
    cpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    os: operatingSystem(),
    runtimes: { node: runtimeVersion('node'), bun: runtimeVersion('bun') },
    packages: Object.fromEntries(packages.map(([name, workspace]) => [name, packageVersion(name, workspace)])),
  }
}
