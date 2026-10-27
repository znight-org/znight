/**
 * `AnalyzeContext.addRoot()` (RFC 0004 §5.5): classes whose only entry point is used by an
 * extension's plugin (a `@Cron` method) are roots of ZNIGHT019 and `prune`, auto-registered as
 * singletons when nothing else registers them, and recorded in compiled libraries.
 */
import type { CompilerExtension, RootDetails } from '../../src/index.ts'
import type { ProvidersFile } from '../../src/library/schema.ts'
import type { TempDir } from '../project/helpers.ts'

import fs from 'node:fs'

import { compile, generate } from '../../src/compiler.ts'
import { analyzeRoot, codes, provider, renderDiagnostics, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const JOBS_PACKAGE = {
  'node_modules/@acme/jobs/package.json': JSON.stringify({
    name: '@acme/jobs',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
  }),
  'node_modules/@acme/jobs/index.d.ts': 'export declare function Every(period: string): MethodDecorator\n',
  'node_modules/@acme/jobs/index.js': 'export const Every = () => () => {}\n',
}

/** Calls `addRoot` for every class with an `@Every` method (`details` per class name). */
function jobsExtension(details: Record<string, RootDetails | 'invalid'> = {}): CompilerExtension<string> {
  return {
    apiVersion: 1,
    name: 'jobs',
    decorators: { '@acme/jobs#Every': { targets: ['method'], params: ['static'] } },
    analyzeClass(cls, ctx) {
      const detail = details[cls.name]
      if (detail === 'invalid') {
        ctx.addRoot({ identity: 42 } as never)
        return
      }
      const token = ctx.addRoot(cls, detail ?? { reason: 'scheduled job host' })
      ctx.addRoot(cls, { reason: 'twice is harmless' })
      ctx.store(token)
    },
  }
}

const SOURCES = {
  'src/report.ts': `
import { Injectable } from '@znight/core'
@Injectable()
export class ReportService {
  build(): string {
    return 'report'
  }
}
`,
  'src/report.jobs.ts': `
import { Every } from '@acme/jobs'
import { ReportService } from './report.ts'
export class ReportJobs {
  constructor(readonly reports: ReportService) {}
  @Every('1h')
  daily(): void {}
}
`,
  'src/scoped.jobs.ts': `
import { Injectable } from '@znight/core'
import { Every } from '@acme/jobs'
@Injectable({ scope: 'transient' })
export class ScopedJobs {
  @Every('1m')
  tick(): void {}
}
`,
  'src/unused.ts': `
import { Injectable } from '@znight/core'
@Injectable()
export class UnusedService {}
`,
}

describe('AnalyzeContext.addRoot', () => {
  let app: TempDir

  beforeAll(() => {
    app = tempApp({ ...JOBS_PACKAGE, ...SOURCES })
  })
  afterAll(() => app.cleanup())

  it('auto-registers hosts as singletons, keeps registered ones, and makes them roots', async () => {
    const result = await analyzeRoot(app.root, { extensions: [jobsExtension()], reportUnused: true })
    expect(codes(result)).toEqual(['ZNIGHT019 src/unused.ts:4:14'])
    expect(provider(result, 'src/report.jobs.ts#ReportJobs')).toMatchObject({
      registeredBy: 'auto',
      scope: 'singleton',
      deps: [expect.objectContaining({ ref: 'src/report.ts#ReportService' })],
    })
    expect(provider(result, 'src/scoped.jobs.ts#ScopedJobs')).toMatchObject({
      registeredBy: 'core',
      scope: 'transient',
    })
    expect(result.graph.roots.map(root => [root.token, root.origin, root.reason, root.location?.line])).toEqual([
      ['src/report.jobs.ts#ReportJobs', "extension 'jobs'", 'scheduled job host', 6],
      ['src/scoped.jobs.ts#ScopedJobs', "extension 'jobs'", 'scheduled job host', 6],
    ])
    expect(result.graph.reachability?.roots).toEqual(['src/report.jobs.ts#ReportJobs', 'src/scoped.jobs.ts#ScopedJobs'])
    expect(result.graph.reachability?.unreachable).toEqual(['src/unused.ts#UnusedService'])
    expect(result.graph.extensions.find(entry => entry.name === 'jobs')?.stored).toEqual([
      'src/report.jobs.ts#ReportJobs',
      'src/scoped.jobs.ts#ScopedJobs',
    ])
  })

  it('without addRoot, the host is not a provider and its dependencies are unused (control)', async () => {
    const extension = { ...jobsExtension(), analyzeClass: undefined }
    const result = await analyzeRoot(app.root, { extensions: [extension], reportUnused: true })
    expect(codes(result)).toEqual([
      'ZNIGHT019 src/report.ts:4:14',
      'ZNIGHT019 src/scoped.jobs.ts:5:14',
      'ZNIGHT019 src/unused.ts:4:14',
    ])
    expect(result.graph.providers.some(entry => entry.token === 'src/report.jobs.ts#ReportJobs')).toBe(false)
    expect(result.graph.roots).toEqual([])
  })

  it('computes roots without reportUnused, and prune keeps the hosts and their dependencies', async () => {
    const plain = await analyzeRoot(app.root, { extensions: [jobsExtension()] })
    expect(plain.graph.reachability).toBeUndefined()
    expect(plain.graph.roots).toHaveLength(2)

    const result = await compile({ root: app.root, extensions: [jobsExtension()], prune: true, mode: 'build' })
    expect(result.ok).toBe(true)
    expect(result.code).toContain("['src/report.jobs.ts#ReportJobs']")
    expect(result.code).toContain("['src/report.ts#ReportService']")
    expect(result.code).not.toContain('UnusedService')
  })

  it('reports the auto-registration problems of a host at the given location', async () => {
    const broken = tempApp({
      ...JOBS_PACKAGE,
      'src/abstract.jobs.ts': `
import { Every } from '@acme/jobs'
export abstract class AbstractJobs {
  @Every('1h')
  run(): void {}
}
`,
      'src/hidden.jobs.ts': `
import { Every } from '@acme/jobs'
class HiddenJobs {
  @Every('1h')
  run(): void {}
}
export const hidden = HiddenJobs
`,
    })
    try {
      const result = await analyzeRoot(broken.root, { extensions: [jobsExtension()] })
      expect(renderDiagnostics(result.root, result.diagnostics)).toMatchSnapshot()
    } finally {
      broken.cleanup()
    }
  })

  it('an invalid argument is an extension failure (ZNIGHT018)', async () => {
    const result = await analyzeRoot(app.root, { extensions: [jobsExtension({ ReportJobs: 'invalid' })] })
    expect(codes(result)).toEqual(['ZNIGHT018 src/report.jobs.ts:4:14'])
    expect(result.diagnostics[0]?.message).toContain('addRoot(cls) expects a ClassInfo')
  })
})

describe('roots of compiled provider libraries', () => {
  let library: TempDir
  let app: TempDir

  beforeAll(() => {
    library = tempApp({
      ...JOBS_PACKAGE,
      'src/index.ts': "export * from './cleanup.ts'\nexport * from './store.ts'\n",
      'src/store.ts': "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Store {}\n",
      'src/cleanup.ts': `import { Every } from '@acme/jobs'
import { Store } from './store.ts'
export class CleanupJobs {
  constructor(readonly store: Store) {}
  @Every('1d')
  purge(): void {}
}
`,
      'dist/index.js':
        'export class Store {}\nexport class CleanupJobs {\n  constructor(store) {\n    this.store = store\n  }\n  purge() {}\n}\n',
      'dist/index.d.ts':
        'export declare class Store {}\nexport declare class CleanupJobs {\n  readonly store: Store\n  constructor(store: Store)\n  purge(): void\n}\n',
    })
    library.write(
      'package.json',
      JSON.stringify({
        name: '@acme/cleanup',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { 'acme-source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' } },
        dependencies: { '@acme/jobs': '1.0.0', '@znight/core': '0.1.0' },
        znight: { apiVersion: 1, providers: './dist/znight.providers.json' },
      }),
    )
    app = tempApp({
      ...JOBS_PACKAGE,
      'src/main.ts': "import { Store } from '@acme/cleanup'\nexport const store = Store\n",
    })
    app.write(
      'package.json',
      JSON.stringify({
        name: 'cleanup-app',
        private: true,
        type: 'module',
        dependencies: { '@acme/cleanup': '1.0.0', '@acme/jobs': '1.0.0', '@znight/core': '0.1.0' },
      }),
    )
    fs.mkdirSync(`${app.root}/node_modules/@acme`, { recursive: true })
    fs.symlinkSync(library.root, `${app.root}/node_modules/@acme/cleanup`, 'dir')
  })
  afterAll(() => {
    app.cleanup()
    library.cleanup()
  })

  it('records the roots in znight.providers.json and keeps them in the application', async () => {
    const built = await generate({
      root: library.root,
      library: true,
      conditions: ['acme-source'],
      extensions: [jobsExtension()],
    })
    expect(built.ok).toBe(true)
    const fragment = JSON.parse(fs.readFileSync(`${library.root}/dist/znight.providers.json`, 'utf8')) as ProvidersFile
    expect(fragment.roots).toEqual(['@acme/cleanup#CleanupJobs'])
    expect(fragment.providers.map(entry => [entry.token, entry.registeredBy])).toEqual([
      ['@acme/cleanup#CleanupJobs', 'auto'],
      ['@acme/cleanup#Store', 'core'],
    ])

    const result = await analyzeRoot(app.root, { extensions: [jobsExtension()], reportUnused: true })
    expect(codes(result)).toEqual([])
    expect(result.graph.roots).toEqual([
      expect.objectContaining({ token: '@acme/cleanup#CleanupJobs', origin: 'compiled library @acme/cleanup' }),
    ])
    const pruned = await compile({ root: app.root, extensions: [jobsExtension()], prune: true })
    expect(pruned.code).toContain("['@acme/cleanup#CleanupJobs']")
  })

  it('reports a malformed roots entry (ZNIGHT018)', async () => {
    const file = `${library.root}/dist/znight.providers.json`
    const original = fs.readFileSync(file, 'utf8')
    try {
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), roots: [42] }))
      const result = await analyzeRoot(app.root, { extensions: [jobsExtension()] })
      expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
        expect.stringContaining('malformed file ("roots" must be an array of tokens)'),
      ])
    } finally {
      fs.writeFileSync(file, original)
    }
  })
})
