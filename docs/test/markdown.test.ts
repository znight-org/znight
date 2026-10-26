/**
 * Code samples of the user-facing Markdown (the root README, this site, the package and example
 * READMEs) against the packages they document:
 *
 * - every `import ... from '@znight/...'` names a package of the repository, one of its
 *   `package.json#exports` subpaths, and only names that subpath exports (values and types);
 * - the root README, the landing page on GitHub that scaffolded projects and examples link to,
 *   only names existing packages, links to existing files and headings, and bootstraps the
 *   application with the generated metadata.
 *
 * Exports are read statically from the `@znight/source` entry of each subpath, following
 * `export ... from` and `export *`: nothing is loaded, so optional integrations (fastify,
 * amqplib...) need not be installed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { describe, expect, test as it } from 'bun:test'

const repoRoot = resolve(import.meta.dir, '../..')
const SOURCE_CONDITION = '@znight/source'

type ExportTarget = string | Readonly<Record<string, string>>

interface Manifest {
  readonly name: string
  readonly exports?: Readonly<Record<string, ExportTarget>>
}

/** Workspace packages by name, with the source file of each export subpath. */
function readPackages(): Map<string, ReadonlyMap<string, string>> {
  const packages = new Map<string, ReadonlyMap<string, string>>()
  const dir = join(repoRoot, 'packages')
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const manifestPath = join(dir, entry.name, 'package.json')
    if (!(entry.isDirectory() && existsSync(manifestPath))) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    const entries = new Map<string, string>()
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const file = typeof target === 'string' ? target : target[SOURCE_CONDITION]
      if (file?.endsWith('.ts')) entries.set(subpath, join(dir, entry.name, file))
    }
    packages.set(manifest.name, entries)
  }
  return packages
}

const packages = readPackages()

/** Names exported by a TypeScript module (values and types), following re-exports. */
function exportedNames(file: string, seen: Set<string> = new Set()): Set<string> {
  const names = new Set<string>()
  if (seen.has(file)) return names
  seen.add(file)
  const source = readFileSync(file, 'utf8')
  const resolveFrom = (specifier: string): string | undefined =>
    specifier.startsWith('.') ? resolve(dirname(file), specifier) : undefined

  const declaration =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|interface|type|function\*?|const|let|var|enum|namespace)\s+([\w$]+)/gm
  for (const match of source.matchAll(declaration)) names.add(match[1] ?? '')
  if (/^export\s+default\b/m.test(source)) names.add('default')

  for (const match of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const specifier of (match[1] ?? '').split(',')) {
      const parts = specifier
        .replace(/\/\/.*$/gm, '')
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
      const name = parts.at(-1)?.trim()
      if (name) names.add(name)
    }
  }

  for (const match of source.matchAll(/^export\s+\*\s+as\s+([\w$]+)\s+from/gm)) names.add(match[1] ?? '')
  for (const match of source.matchAll(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm)) {
    const target = resolveFrom(match[1] ?? '')
    if (target !== undefined) for (const name of exportedNames(target, seen)) names.add(name)
  }
  return names
}

const exportsCache = new Map<string, Set<string>>()

function exportsOf(file: string): Set<string> {
  let names = exportsCache.get(file)
  if (names === undefined) {
    names = exportedNames(file)
    exportsCache.set(file, names)
  }
  return names
}

/** The code of a Markdown document: fenced blocks and inline code spans. */
function codeOf(markdown: string): string[] {
  const code: string[] = []
  let fence: string | undefined
  let block: string[] = []
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === undefined && marker !== undefined) {
      fence = marker
      block = []
    } else if (fence !== undefined && marker !== undefined && line.trim().startsWith(fence)) {
      code.push(block.join('\n'))
      fence = undefined
    } else if (fence === undefined) {
      for (const span of line.matchAll(/`([^`]+)`/g)) code.push(span[1] ?? '')
    } else {
      block.push(line)
    }
  }
  return code
}

interface ZnightImport {
  readonly specifier: string
  /** Imported names (`default` for a default import); empty for namespace and side-effect imports. */
  readonly names: readonly string[]
}

function znightImports(code: string): ZnightImport[] {
  const imports: ZnightImport[] = []
  const statement = /\bimport\s+(?:([\w$\s{},*]*?)\s*from\s*)?['"](@znight\/[^'"]+)['"]/g
  for (const match of code.matchAll(statement)) {
    const clause = (match[1] ?? '').replace(/^type\s+/, '')
    const names: string[] = []
    const braces = /\{([^}]*)\}/.exec(clause)
    for (const specifier of braces?.[1]?.split(',') ?? []) {
      const name = specifier
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim()
      if (name) names.push(name)
    }
    const defaultImport = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim())?.[1]
    if (defaultImport !== undefined) names.push('default')
    imports.push({ specifier: match[2] ?? '', names })
  }
  return imports
}

/** Source file of `@znight/<pkg>[/<subpath>]`, or why it cannot be imported. */
function resolveSpecifier(specifier: string): { readonly file: string } | { readonly error: string } {
  const [scope, name, ...rest] = specifier.split('/')
  const packageName = `${scope}/${name}`
  const entries = packages.get(packageName)
  if (entries === undefined) return { error: `'${packageName}' is not a package of the repository` }
  const subpath = rest.length === 0 ? '.' : `./${rest.join('/')}`
  const file = entries.get(subpath)
  if (file === undefined) return { error: `'${specifier}' is not exported by ${packageName}` }
  return { file }
}

/** Problems with the `@znight/*` imports of a Markdown document. */
function importProblems(markdown: string): string[] {
  const problems: string[] = []
  for (const code of codeOf(markdown)) {
    for (const { specifier, names } of znightImports(code)) {
      const resolved = resolveSpecifier(specifier)
      if ('error' in resolved) {
        problems.push(resolved.error)
        continue
      }
      const exported = exportsOf(resolved.file)
      for (const name of names) {
        if (!exported.has(name)) problems.push(`'${specifier}' does not export '${name}'`)
      }
    }
  }
  return [...new Set(problems)]
}

/** The `Application.create(...)` calls of `code`, up to their closing parenthesis. */
function createCalls(code: string): string[] {
  const calls: string[] = []
  for (const match of code.matchAll(/Application\.create\(/g)) {
    let depth = 1
    let end = match.index + match[0].length
    while (depth > 0 && end < code.length) {
      const char = code[end++]
      if (char === '(') depth++
      else if (char === ')') depth--
    }
    calls.push(code.slice(match.index, end))
  }
  return calls
}

/** Markdown files under `dir` (relative to the repository), `README.md` only when `readmesOnly`. */
function markdownFiles(dir: string, readmesOnly: boolean): string[] {
  const skipped = new Set(['node_modules', 'dist', 'test', 'public'])
  const result: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skipped.has(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (readmesOnly ? entry.name === 'README.md' : entry.name.endsWith('.md')) {
        result.push(relative(repoRoot, path).split('\\').join('/'))
      }
    }
  }
  walk(join(repoRoot, dir))
  return result.sort()
}

const documents = [
  'README.md',
  ...markdownFiles('docs', false),
  ...markdownFiles('packages', true),
  ...markdownFiles('examples', true),
]

describe('helpers', () => {
  it('extract imports from fenced blocks and inline code only', () => {
    const markdown = [
      'Prose that imports things from `x` is ignored, and so is import { A } from "@znight/nope".',
      '',
      '```ts',
      "import { Injectable, type OnStart } from '@znight/core'",
      "import type { HttpContext } from '@znight/http'",
      "import { fastifyAdapter as fastify } from '@znight/http/fastify'",
      "import '@znight/compiler/bun'",
      '```',
      '',
      "Inline: `import { Logger } from '@znight/observability'`.",
    ].join('\n')
    expect(codeOf(markdown).flatMap(znightImports)).toEqual([
      { specifier: '@znight/core', names: ['Injectable', 'OnStart'] },
      { specifier: '@znight/http', names: ['HttpContext'] },
      { specifier: '@znight/http/fastify', names: ['fastifyAdapter'] },
      { specifier: '@znight/compiler/bun', names: [] },
      { specifier: '@znight/observability', names: ['Logger'] },
    ])
  })

  it('read value and type exports through re-exports', () => {
    const core = resolveSpecifier('@znight/core')
    if (!('file' in core)) throw new Error(core.error)
    const names = exportsOf(core.file)
    expect(names).toContain('Application') // export { Application } from
    expect(names).toContain('ZnightMetadata') // export type, through export * from './metadata.ts'
    expect(names).toContain('ErrorCode') // export * from './errors.ts'
    expect(names).not.toContain('Logger')
  })

  it('read Application.create() calls up to their closing parenthesis', () => {
    const code = 'await Application.create({\n  plugins: [Http.configure({ port: 0 })],\n  metadata,\n})\nfoo()'
    expect(createCalls(code)).toEqual([
      'Application.create({\n  plugins: [Http.configure({ port: 0 })],\n  metadata,\n})',
    ])
  })

  it('reject unknown packages, subpaths and names', () => {
    const markdown = [
      '```ts',
      "import { Logger } from '@znight/logging'",
      "import { HttpPlugin, FastifyAdapter } from '@znight/http'",
      "import { rabbitmq } from '@znight/messaging/amqp'",
      "import { MessagingPlugin, RabbitMQDriver } from '@znight/messaging'",
      '```',
    ].join('\n')
    expect(importProblems(markdown)).toEqual([
      "'@znight/logging' is not a package of the repository",
      "'@znight/http' does not export 'FastifyAdapter'",
      "'@znight/messaging/amqp' is not exported by @znight/messaging",
      "'@znight/messaging' does not export 'RabbitMQDriver'",
    ])
  })
})

describe('imports in Markdown', () => {
  it('covers the root README, the site and the package and example READMEs', () => {
    expect(documents).toContain('README.md')
    expect(documents).toContain('docs/guide/getting-started.md')
    expect(documents).toContain('packages/core/README.md')
    expect(documents).toContain('examples/rest-api/README.md')
  })

  it.each(documents)('%s imports only what the packages export', document => {
    expect(importProblems(readFileSync(join(repoRoot, document), 'utf8'))).toEqual([])
  })
})

describe('README.md', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')

  it('has code samples importing from the packages', () => {
    expect(codeOf(readme).flatMap(znightImports).length).toBeGreaterThan(5)
  })

  it('names only packages of the repository', () => {
    const named = new Set([...readme.matchAll(/@znight\/([a-z][\w-]*)/g)].map(match => `@znight/${match[1]}`))
    expect([...named].filter(name => !packages.has(name))).toEqual([])
  })

  it('names every package of the repository', () => {
    expect([...packages.keys()].filter(name => !readme.includes(`\`${name}\``))).toEqual([])
  })

  it('links to existing files and headings', () => {
    const anchors = new Set(
      [...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match =>
        (match[1] ?? '')
          .trim()
          .toLowerCase()
          .replace(/[^\w\- ]/g, '')
          .replace(/ /g, '-'),
      ),
    )
    const targets = [
      ...[...readme.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1] ?? ''),
      ...[...readme.matchAll(/\b(?:href|src)="([^"]+)"/g)].map(match => match[1] ?? ''),
    ]
    const broken = targets.filter(target => {
      if (/^[a-z]+:/i.test(target)) return false
      if (target.startsWith('#')) return !anchors.has(target.slice(1))
      return !existsSync(join(repoRoot, target.replace(/[?#].*$/, '')))
    })
    expect(broken).toEqual([])
    expect(targets.length).toBeGreaterThan(10)
  })

  it('bootstraps applications with the generated metadata', () => {
    const calls = codeOf(readme)
      .flatMap(createCalls)
      .filter(call => /^Application\.create\(\s*\{/.test(call))
    expect(calls.filter(call => !/\bmetadata\b/.test(call))).toEqual([])
    expect(calls.length).toBeGreaterThan(1)
  })

  it('documents the repository workflow (Bun, ugho49/Znight)', () => {
    expect(readme.match(/\bpnpm (?:install|build|test|dev)\b.*/g) ?? []).toEqual([])
    expect(readme.match(/.*github\.com\/(?!ugho49\/Znight\b).*/g) ?? []).toEqual([])
    expect(readme).toContain('git clone https://github.com/ugho49/Znight.git')
    expect(readme).toContain('bun install')
  })
})
