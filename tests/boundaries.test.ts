/**
 * Repository boundaries (architecture §2, "Package conventions"), checked for every package from
 * its `package.json#exports`:
 *
 * - `<pkg>/compiler` entries only `import type` from `@znight/compiler` and never import the
 *   package's runtime entry (building never loads fastify, amqplib...);
 * - runtime entries never import `./compiler`;
 * - `@znight/compiler` is at most an optional peer dependency of feature packages and of the CLI.
 *
 * Imports are read with `Bun.Transpiler#scan`, which drops type-only imports: what remains is what
 * runs. The closure of an entry follows its relative imports.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { describe, expect, test as it } from 'bun:test'

const REPO = resolve(import.meta.dir, '..')
const PACKAGES = join(REPO, 'packages')
const COMPILER = '@znight/compiler'
const SOURCE_CONDITION = '@znight/source'

interface Manifest {
  readonly name: string
  readonly exports?: Readonly<Record<string, string | Readonly<Record<string, string>>>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
}

interface Package {
  readonly directory: string
  readonly manifest: Manifest
  /** Source file of each export (`@znight/source` condition), by subpath. */
  readonly entries: ReadonlyMap<string, string>
}

function readPackages(): Package[] {
  const packages: Package[] = []
  for (const name of readdirSync(PACKAGES).sort()) {
    const file = join(PACKAGES, name, 'package.json')
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest
    const entries = new Map<string, string>()
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target !== 'object') continue
      const source = target[SOURCE_CONDITION]
      if (source !== undefined) entries.set(subpath, resolve(PACKAGES, name, source))
    }
    packages.push({ directory: join(PACKAGES, name), manifest, entries })
  }
  return packages
}

const transpiler = new Bun.Transpiler({ loader: 'ts' })
const scanned = new Map<string, readonly string[]>()

/** Specifiers of the value imports of a file (static, re-exports and literal dynamic imports). */
function valueImports(file: string): readonly string[] {
  let imports = scanned.get(file)
  if (imports === undefined) {
    imports = transpiler.scan(readFileSync(file, 'utf8')).imports.map(entry => entry.path)
    scanned.set(file, imports)
  }
  return imports
}

/** A file reached from an entry, with the chain of files leading to it. */
interface Reached {
  readonly file: string
  readonly chain: readonly string[]
}

/** Files reached from `entry` through relative value imports, and the bare specifiers they import. */
function closure(entry: string): { files: Reached[]; bare: { specifier: string; chain: readonly string[] }[] } {
  const files: Reached[] = []
  const bare: { specifier: string; chain: readonly string[] }[] = []
  const seen = new Set<string>()
  const visit = (file: string, chain: readonly string[]): void => {
    if (seen.has(file)) return
    seen.add(file)
    const path = [...chain, file]
    files.push({ file, chain: path })
    for (const specifier of valueImports(file)) {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier)
        if (existsSync(target)) visit(target, path)
      } else {
        bare.push({ specifier, chain: path })
      }
    }
  }
  visit(entry, [])
  return { files, bare }
}

function show(chain: readonly string[]): string {
  return chain.map(file => relative(REPO, file)).join(' -> ')
}

const packages = readPackages()
const compilerEntries = packages.flatMap(pkg =>
  [...pkg.entries].filter(([subpath]) => subpath === './compiler').map(([, file]) => ({ pkg, file })),
)
const runtimeEntries = packages.flatMap(pkg =>
  [...pkg.entries].filter(([subpath]) => subpath !== './compiler').map(([subpath, file]) => ({ pkg, subpath, file })),
)

describe('repository boundaries (architecture §2)', () => {
  it('finds the packages and their entries', () => {
    expect(packages.map(pkg => pkg.manifest.name)).toContain('@znight/core')
    expect(compilerEntries.map(({ pkg }) => pkg.manifest.name).sort()).toEqual([
      '@znight/config',
      '@znight/http',
      '@znight/messaging',
    ])
    expect(runtimeEntries.length).toBeGreaterThanOrEqual(packages.length)
  })

  it('follows relative value imports and ignores type-only imports', () => {
    const http = packages.find(pkg => pkg.manifest.name === '@znight/http')
    const runtime = closure(http?.entries.get('.') ?? '').files.map(({ file }) => relative(REPO, file))
    expect(runtime).toContain('packages/http/src/pipeline.ts')
    const compiler = closure(http?.entries.get('./compiler') ?? '').files.map(({ file }) => relative(REPO, file))
    expect(compiler).toContain('packages/http/src/path.ts')
    expect(valueImports(join(REPO, 'packages/http/src/compiler/index.ts'))).not.toContain(COMPILER)
  })

  describe.each(compilerEntries.map(({ pkg, file }) => [pkg.manifest.name, pkg, file] as const))(
    '%s/compiler',
    (name, pkg, entry) => {
      const { files, bare } = closure(entry)

      it(`only imports types from ${COMPILER}`, () => {
        const values = bare.filter(({ specifier }) => specifier === COMPILER || specifier.startsWith(`${COMPILER}/`))
        expect(values.map(({ specifier, chain }) => `${specifier} (${show(chain)})`)).toEqual([])
      })

      it('never imports the runtime entry of the package', () => {
        const runtime = pkg.entries.get('.')
        expect(runtime).toBeDefined()
        const reached = files.filter(({ file }) => file === runtime)
        expect(reached.map(({ chain }) => show(chain))).toEqual([])
        const self = bare.filter(({ specifier }) => specifier === name || specifier.startsWith(`${name}/`))
        expect(self.map(({ specifier, chain }) => `${specifier} (${show(chain)})`)).toEqual([])
      })

      it('only reaches modules of the package (shared runtime code lives in import-free modules)', () => {
        const outside = files.filter(({ file }) => !file.startsWith(`${pkg.directory}/src/`))
        expect(outside.map(({ chain }) => show(chain))).toEqual([])
      })
    },
  )

  it.each(runtimeEntries.map(({ pkg, subpath, file }) => [`${pkg.manifest.name} ${subpath}`, pkg, file] as const))(
    '%s never imports ./compiler',
    (_name, pkg, entry) => {
      const compilerDirectory = `${pkg.directory}/src/compiler/`
      const reached = closure(entry).files.filter(({ file }) => file.startsWith(compilerDirectory))
      expect(reached.map(({ chain }) => show(chain))).toEqual([])
    },
  )

  it.each(packages.filter(pkg => pkg.manifest.name !== COMPILER).map(pkg => [pkg.manifest.name, pkg] as const))(
    `%s depends on ${COMPILER} at most as an optional peer`,
    (_name, pkg) => {
      const { dependencies = {}, peerDependencies = {}, peerDependenciesMeta = {} } = pkg.manifest
      expect(dependencies[COMPILER]).toBeUndefined()
      if (peerDependencies[COMPILER] !== undefined) {
        expect(peerDependenciesMeta[COMPILER]?.optional).toBe(true)
      }
    },
  )
})
