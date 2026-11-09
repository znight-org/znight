/**
 * Performance smoke test: a generated application of ~500 files is scanned, parsed and every
 * import, constructor parameter type and heritage clause is resolved. Timings are logged; the
 * asserted bounds are deliberately generous (CI machines vary) and only catch pathological
 * regressions (accidental quadratic behaviour, missing caches).
 */

import type { Class } from 'oxc-parser'
import type { ProjectHost } from '../../src/project/host.ts'

import { normalizeOptions } from '../../src/options.ts'
import { Project, SymbolResolver, serializeType } from '../../src/project/index.ts'
import { tempDir } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const MODULES = 170 // 3 files per module + config = 511 files

function generate(): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'perf-app', type: 'module' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./src/*'] } } }),
    'src/config.ts': [
      'export const CONFIG = { port: 3000, prefix: `/api` } as const',
      'export interface Repository<T, ID = string> { find(id: ID): T }',
      'export class Logger {}',
    ].join('\n'),
  }
  for (let index = 0; index < MODULES; index++) {
    const previous = index > 0 ? index - 1 : undefined
    files[`src/modules/m${index}/entity.ts`] = [
      `export interface Entity${index} { id: string; name: string }`,
      `export type Maybe${index} = Entity${index} | undefined`,
      `export const ROUTE_${index} = \`/m${index}\``,
    ].join('\n')
    files[`src/modules/m${index}/service.ts`] = [
      "import { CONFIG, Logger, type Repository } from '@app/config.ts'",
      `import type { Entity${index}, Maybe${index} } from './entity.js'`,
      previous === undefined ? '' : `import { Service${previous} } from '../m${previous}/index.ts'`,
      `export const PATH_${index} = CONFIG.prefix + '/m${index}'`,
      `export class Service${index} {`,
      '  constructor(',
      previous === undefined ? '' : `    readonly previous: Service${previous},`,
      `    readonly repository: Repository<Entity${index}>,`,
      '    readonly logger: Logger,',
      `    readonly current?: Maybe${index},`,
      '  ) {}',
      '}',
    ].join('\n')
    files[`src/modules/m${index}/index.ts`] = "export * from './entity.ts'\nexport * from './service.ts'\n"
  }
  return files
}

describe('performance', () => {
  const dir = tempDir(generate())
  afterAll(() => dir.cleanup())

  it('scans, parses and resolves a 500-file application quickly', () => {
    const start = performance.now()
    const project = new Project(normalizeOptions({ root: dir.root }))
    const refresh = project.refresh()
    const parsed = performance.now()

    let identities = 0
    let types = 0
    let constants = 0
    for (const file of project.files()) {
      for (const name of file.facts.imports.keys()) {
        if (project.resolveIdentifier(file, name).identity) {
          identities++
        }
      }
      for (const declarations of file.facts.declarations.values()) {
        for (const declaration of declarations) {
          if (declaration.kind === 'class') {
            const node = declaration.node as Class
            const ctor = node.body.body.find(
              member => member.type === 'MethodDefinition' && member.kind === 'constructor',
            )
            const params = ctor?.type === 'MethodDefinition' ? ctor.value.params : []
            for (const param of params) {
              const annotation = param.type === 'TSParameterProperty' ? param.parameter.typeAnnotation : undefined
              serializeType(project.resolveType(file, annotation))
              types++
            }
            project.heritageOf(declaration)
          }
          if (declaration.kind === 'const' && declaration.node.type === 'VariableDeclarator' && declaration.node.init) {
            if (project.evaluate(file, declaration.node.init).kind === 'value') {
              constants++
            }
          }
        }
      }
    }
    const resolved = performance.now()

    const changed = `${dir.root}/src/modules/m42/service.ts`
    dir.write('src/modules/m42/service.ts', `${project.getFile(changed)?.text}\nexport const EXTRA = 1\n`)
    const incremental = project.refresh({ changed: [changed] })
    const incrementalDone = performance.now()

    const timings = {
      files: refresh.files,
      scanAndParseMs: Math.round(parsed - start),
      resolveMs: Math.round(resolved - parsed),
      incrementalRefreshMs: Math.round(incrementalDone - resolved),
      identities,
      types,
      constants,
    }
    console.log('[perf] project model', timings)

    expect(refresh.files).toBe(MODULES * 3 + 1)
    expect(identities).toBe(MODULES * 6 - 1)
    expect(types).toBe(MODULES * 4 - 1)
    expect(constants).toBe(MODULES * 2 + 1)
    expect(incremental).toMatchObject({ parsed: 1, reused: 0, rescanned: false })
    // Generous bounds: typical timings are 10-20x lower.
    expect(parsed - start).toBeLessThan(5000)
    expect(resolved - parsed).toBeLessThan(5000)
    expect(incrementalDone - resolved).toBeLessThan(1000)
  })
})

describe('export * cycles', () => {
  /** `size` modules that each `export *` every other one and declare one class. */
  function clique(size: number): Record<string, string> {
    const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'clique-app' }) }
    for (let index = 0; index < size; index++) {
      const stars = Array.from({ length: size }, (_, other) => other)
        .filter(other => other !== index)
        .map(other => `export * from './m${other}.ts'`)
      files[`src/m${index}.ts`] = [...stars, `export class C${index} {}`].join('\n')
    }
    return files
  }

  /** Resolves every export of m0 with a fresh resolver: the `getFile` calls and the results. */
  function resolveAll(size: number): { calls: number; results: string[] } {
    const dir = tempDir(clique(size))
    try {
      const project = new Project(normalizeOptions({ root: dir.root }))
      project.refresh()
      let calls = 0
      const host: ProjectHost = {
        options: project.options,
        packages: project.packages,
        getFile: path => {
          calls++
          return project.getFile(path)
        },
        resolveModule: (...args) => project.resolveModule(...args),
        resolveFromDirectory: (...args) => project.resolveFromDirectory(...args),
        manifestOf: info => project.manifestOf(info),
      }
      const symbols = new SymbolResolver(host)
      const m0 = `${dir.root}/src/m0.ts`
      const results = symbols.exportNames(m0).map(name => {
        const symbol = symbols.resolveExport(m0, name)
        return symbol.kind === 'declaration' ? `${name}:${symbol.declaration.file.slice(dir.root.length)}` : symbol.kind
      })
      return { calls, results }
    } finally {
      dir.cleanup()
    }
  }

  it('each lookup visits every module once, with unchanged results', () => {
    const small = resolveAll(5)
    const large = resolveAll(10)
    expect(small.results).toEqual(Array.from({ length: 5 }, (_, index) => `C${index}:/src/m${index}.ts`))
    expect(large.results).toEqual(Array.from({ length: 10 }, (_, index) => `C${index}:/src/m${index}.ts`))
    // `size` lookups over `size * (size - 1)` star edges: cubic, so doubling the size costs about 8x
    // (a walk of every path costs millions of reads at size 10)
    expect(large.calls).toBeLessThan(small.calls * 10)
    expect(large.calls).toBeLessThan(2 * 10 ** 3)
  })

  it('stay linear under diamonds of barrels over a cycle', () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'diamond-app' }),
      'src/cycle/a.ts': "export * from './b.ts'\nexport class A {}",
      'src/cycle/b.ts': "export * from './a.ts'\nexport class B {}",
    }
    const DEPTH = 20
    for (let level = 0; level < DEPTH; level++) {
      const below = (side: string): string =>
        level === DEPTH - 1 ? `export * from '../cycle/${side}.ts'` : `export * from './l${level + 1}${side}.ts'`
      for (const side of ['a', 'b']) {
        files[`src/barrels/l${level}${side}.ts`] = [below('a'), below('b')].join('\n')
      }
    }
    const dir = tempDir(files)
    try {
      const project = new Project(normalizeOptions({ root: dir.root }))
      project.refresh()
      const top = `${dir.root}/src/barrels/l0a.ts`
      const start = performance.now()
      const resolved = ['A', 'B', 'Missing'].map(name => project.resolveExport(top, name))
      const elapsed = performance.now() - start
      expect(resolved.map(symbol => (symbol.kind === 'unresolved' ? symbol.reason : symbol.kind))).toEqual([
        'declaration',
        'declaration',
        'export-not-found',
      ])
      expect(project.exportNames(top)).toEqual(['A', 'B'])
      expect(elapsed).toBeLessThan(500)
    } finally {
      dir.cleanup()
    }
  })
})
