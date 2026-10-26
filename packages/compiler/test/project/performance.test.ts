/**
 * Performance smoke test: a generated application of ~500 files is scanned, parsed and every
 * import, constructor parameter type and heritage clause is resolved. Timings are logged; the
 * asserted bounds are deliberately generous (CI machines vary) and only catch pathological
 * regressions (accidental quadratic behaviour, missing caches).
 */

import type { Class } from 'oxc-parser'

import { normalizeOptions } from '../../src/options.ts'
import { Project, serializeType } from '../../src/project/index.ts'
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
