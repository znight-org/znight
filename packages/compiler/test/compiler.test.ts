/**
 * Programmatic API: compile() (pure), generate() (writes only when changed, never with errors,
 * check mode), createCompiler() (incremental, serialized), syntax errors, version skew, prune.
 */
import fs from 'node:fs'

import { renderErrorModule } from '../src/codegen/error-module.ts'
import { compile, createCompiler, generate } from '../src/compiler.ts'
import { compatibleVersions, parseVersion } from '../src/version.ts'
import { tempApp } from './analysis/helpers.ts'
import { codesOf, render } from './codegen/helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const SERVICE = `import { Injectable } from '@znight/core'
@Injectable()
export class Service {}
`

describe('compile()', () => {
  const app = tempApp({ 'src/service.ts': SERVICE })
  afterAll(() => app.cleanup())

  it('is pure: returns the module without writing it', async () => {
    const result = await compile({ root: app.root })
    expect(result.ok).toBe(true)
    expect(result.outFile).toBe(`${app.root}/src/.znight/container.generated.ts`)
    expect(result.code).toContain("['src/service.ts#Service']")
    expect(fs.existsSync(result.outFile)).toBe(false)
    expect(result.stats).toMatchObject({ files: 1, providers: 1, parsed: 1 })
    expect(result.watchFiles).toEqual([`${app.root}/package.json`, `${app.root}/src/service.ts`])
    expect(result.library).toBeUndefined()
    const source = fs.readFileSync(`${app.root}/src/service.ts`, 'utf8')
    const ranges = result.decorators.get(`${app.root}/src/service.ts`)
    expect(ranges?.ranges.map(range => source.slice(range.start, range.end))).toEqual(['@Injectable()'])
    expect(ranges?.hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it('records the ranges of every Znight decorator (class, members, parameters) and only those', async () => {
    const app2 = tempApp({
      'src/a.ts': `import { Factory, Inject, Injectable, Named, Optional, Provides } from '@znight/core'
const local = () => (_target: object) => {}
@local()
@Injectable()
@Named('a')
export class A {
  constructor(@Inject('x') readonly x: string, @Optional() readonly y?: A) {}
}
@Factory()
export class F {
  @Provides({ name: 'x' })
  x(): string {
    return 'x'
  }
}
`,
    })
    try {
      const result = await compile({ root: app2.root })
      const source = fs.readFileSync(`${app2.root}/src/a.ts`, 'utf8')
      const ranges = result.decorators.get(`${app2.root}/src/a.ts`)?.ranges ?? []
      expect(ranges.map(range => source.slice(range.start, range.end))).toEqual([
        '@Injectable()',
        "@Named('a')",
        "@Inject('x')",
        '@Optional()',
        '@Factory()',
        "@Provides({ name: 'x' })",
      ])
    } finally {
      app2.cleanup()
    }
  })

  it('validates the mode', () => {
    expect(() => createCompiler({ root: app.root, mode: 'prod' as never })).toThrow('option "mode"')
  })
})

describe('generate()', () => {
  const app = tempApp({ 'src/service.ts': SERVICE })
  afterAll(() => app.cleanup())
  const options = { root: app.root }
  const outFile = `${app.root}/src/.znight/container.generated.ts`

  it('writes the module only when its content changed', async () => {
    const check = await generate({ ...options, check: true })
    expect(check.stale).toBe(true)
    expect(check.written).toEqual([])
    expect(fs.existsSync(outFile)).toBe(false)

    const first = await generate(options)
    expect(first.written).toEqual([outFile])
    expect(fs.readFileSync(outFile, 'utf8')).toBe(first.code)
    const stat = fs.statSync(outFile)

    const second = await generate(options)
    expect(second.written).toEqual([])
    expect(fs.statSync(outFile).mtimeMs).toBe(stat.mtimeMs)
    expect((await generate({ ...options, check: true })).stale).toBe(false)
    expect(fs.readdirSync(`${app.root}/src/.znight`)).toEqual(['container.generated.ts'])
  })

  it('never writes when there are errors, and check mode reports staleness without writing', async () => {
    const before = fs.readFileSync(outFile, 'utf8')
    app.write(
      'src/broken.ts',
      "import { Injectable } from '@znight/core'\nimport type { Missing } from './nope.ts'\n@Injectable()\nexport class Broken { constructor(readonly missing: Missing) {} }\n",
    )
    const failed = await generate(options)
    expect(failed.ok).toBe(false)
    expect(failed.written).toEqual([])
    expect(failed.code).toContain('throw new ZnightError(')
    expect(fs.readFileSync(outFile, 'utf8')).toBe(before)
    app.remove('src/broken.ts')

    app.write('src/other.ts', SERVICE.replace('Service', 'Other'))
    const stale = await generate({ ...options, check: true })
    expect(stale.ok).toBe(true)
    expect(stale.stale).toBe(true)
    expect(fs.readFileSync(outFile, 'utf8')).toBe(before)
    app.remove('src/other.ts')
  })
})

describe('diagnostics of compile()', () => {
  it('reports syntax errors (ZNIGHT022) first', async () => {
    const app = tempApp({
      'src/a.ts':
        "import { Injectable } from '@znight/core'\nimport { Gone } from './broken.ts'\n@Injectable()\nexport class A { constructor(readonly gone: Gone) {} }\n",
      'src/broken.ts':
        "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Gone {\n  method( {\n}\n",
    })
    try {
      const result = await compile({ root: app.root })
      expect(result.ok).toBe(false)
      expect(result.diagnostics[0]?.code).toBe('ZNIGHT022')
      expect(result.diagnostics[0]?.location?.file).toBe(`${app.root}/src/broken.ts`)
      expect(result.diagnostics[0]?.message).toStartWith('Syntax error: ')
      expect(codesOf(app.root, result.diagnostics).slice(1)).toEqual(['ZNIGHT010 src/a.ts:4'])
      expect(result.code).toContain("throw new ZnightError('ZNIGHT022'")
    } finally {
      app.cleanup()
    }
  })

  it('reports @znight/* packages of another release line (ZNIGHT018)', async () => {
    const app = tempApp({
      'src/service.ts': SERVICE,
      'node_modules/@znight/http/package.json': JSON.stringify({ name: '@znight/http', version: '0.2.0' }),
      'node_modules/@znight/messaging/package.json': JSON.stringify({ name: '@znight/messaging', version: '0.1.7' }),
    })
    try {
      app.write(
        'package.json',
        JSON.stringify(
          {
            name: 'temp-app',
            private: true,
            type: 'module',
            dependencies: { '@znight/http': '^0.2.0', '@znight/messaging': '0.1.7' },
          },
          null,
          2,
        ),
      )
      const result = await compile({ root: app.root })
      expect(result.ok).toBe(false)
      expect(codesOf(app.root, result.diagnostics)).toEqual(['ZNIGHT018 package.json:6'])
      expect(render(app.root, result.diagnostics)).toContain(
        '✗ ZNIGHT018: @znight/http@0.2.0 is not compatible with @znight/compiler@',
      )
      expect(result.diagnostics[0]?.hints?.[0]).toContain('install @znight/http@0.1.x')
    } finally {
      app.cleanup()
    }
  })

  it('compares versions by release line', () => {
    expect(parseVersion('0.1.0-beta.1')).toEqual({ major: 0, minor: 1, patch: 0 })
    expect(parseVersion('workspace:*')).toBeUndefined()
    expect(compatibleVersions('0.1.0', '0.1.9')).toBe(true)
    expect(compatibleVersions('0.1.0', '0.2.0')).toBe(false)
    expect(compatibleVersions('1.2.0', '1.9.3')).toBe(true)
    expect(compatibleVersions('1.0.0', '2.0.0')).toBe(false)
    expect(compatibleVersions('0.9.0', '1.0.0')).toBe(false)
    expect(compatibleVersions('next', '1.0.0')).toBe(true)
  })

  it('prunes unreachable providers and passes reportUnused through', async () => {
    const app = tempApp({
      'src/services.ts': `import { Injectable, type OnStart } from '@znight/core'
@Injectable()
export class Used {}
@Injectable()
export class Root implements OnStart {
  constructor(readonly used: Used) {}
  onStart(): void {}
}
@Injectable()
export class Unused {}
`,
    })
    try {
      const all = await compile({ root: app.root })
      expect(all.code).toContain('Unused')
      const pruned = await compile({ root: app.root, prune: true })
      expect(pruned.ok).toBe(true)
      expect(pruned.code).not.toContain('Unused')
      expect(pruned.graph.providers.map(provider => provider.displayName)).toEqual(['Root', 'Used'])
      expect(pruned.stats.providers).toBe(2)
      const reported = await compile({ root: app.root, reportUnused: true })
      expect(codesOf(app.root, reported.diagnostics)).toEqual(['ZNIGHT019 src/services.ts:10'])
      expect(reported.ok).toBe(true)
    } finally {
      app.cleanup()
    }
  })

  it('reports provider modules importing the generated module (ZNIGHT020)', async () => {
    const app = tempApp({
      'src/service.ts': `import { Injectable } from '@znight/core'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'
@Injectable()
export class Service {
  readonly metadata = __ZNIGHT_METADATA__
}
`,
    })
    try {
      const result = await compile({ root: app.root })
      expect(codesOf(app.root, result.diagnostics)).toEqual(['ZNIGHT020 src/service.ts:2'])
    } finally {
      app.cleanup()
    }
  })
})

describe('error module', () => {
  it('throws a ZnightError with the formatted diagnostics when imported', async () => {
    const app = tempApp({
      'src/a.ts':
        "import { Injectable } from '@znight/core'\nimport type { Missing } from './missing.ts'\n@Injectable()\nexport class A {\n  constructor(readonly missing: Missing) {}\n}\n",
    })
    try {
      const result = await compile({ root: app.root })
      app.write('src/.znight/container.generated.ts', result.code)
      const error = await import(`${app.root}/src/.znight/container.generated.ts`).then(
        () => undefined,
        (caught: unknown) => caught as Error & { code: string },
      )
      expect(error?.name).toBe('ZnightError')
      expect(error?.code).toBe('ZNIGHT010')
      expect(error?.message).toContain('The Znight compilation failed')
      expect(error?.message).toContain('--> src/a.ts:5:33')
      expect(error?.message).toContain('Build failed with 1 error')
    } finally {
      app.cleanup()
    }
  })

  it('renders a module even without diagnostics', () => {
    const code = renderErrorModule([], { version: '9.9.9' })
    expect(code).toContain('@znight/compiler 9.9.9')
    expect(code).toContain(
      "throw new ZnightError('ZNIGHT018', 'The Znight compilation failed, the generated container is unusable.\\n\\nUnknown error')",
    )
    expect(code).toContain('export const __ZNIGHT_METADATA__: ZnightMetadata = fail()')
  })
})

describe('createCompiler()', () => {
  const app = tempApp({ 'src/service.ts': SERVICE })
  afterAll(() => app.cleanup())

  it('serializes compiles and coalesces the calls made while one runs', async () => {
    const compiler = createCompiler({ root: app.root })
    expect(compiler.last).toBeUndefined()
    const first = compiler.compile()
    app.write('src/second.ts', SERVICE.replace('Service', 'Second'))
    const second = compiler.compile({ added: [`${app.root}/src/second.ts`] })
    app.write('src/third.ts', SERVICE.replace('Service', 'Third'))
    const third = compiler.compile({ added: ['src/third.ts'] })
    const [a, b, c] = await Promise.all([first, second, third])
    expect(b).toBe(c)
    expect(a.code).toContain('Service')
    expect(c.code).toContain('Second')
    expect(c.code).toContain('Third')
    expect(compiler.last).toBe(c)
    app.remove('src/second.ts')
    app.remove('src/third.ts')
  })

  it('knows its out file and reloads extensions on demand', async () => {
    const compiler = createCompiler({ root: app.root, mode: 'build' })
    expect(compiler.mode).toBe('build')
    expect(compiler.isOutFile('src/.znight/container.generated.ts')).toBe(true)
    expect(compiler.isOutFile(`${app.root}/src/.znight/container.generated.ts`)).toBe(true)
    expect(compiler.isOutFile('src/service.ts')).toBe(false)
    const first = await compiler.compile()
    compiler.reloadExtensions()
    const second = await compiler.compile({ changed: ['src/service.ts'] })
    expect(second.code).toBe(first.code)
    expect(second.stats.parsed).toBe(0)
    // the generated module reported by a watcher is ignored (no rescan)
    const third = await compiler.compile({ added: ['src/.znight/container.generated.ts'] })
    expect(third.code).toBe(first.code)
  })

  it('generates through the incremental compiler', async () => {
    const compiler = createCompiler({ root: app.root })
    const result = await compiler.generate()
    expect(result.written).toEqual([`${app.root}/src/.znight/container.generated.ts`])
    expect((await compiler.generate(undefined, { check: true })).stale).toBe(false)
    expect((await compiler.generate({ changed: [] })).written).toEqual([])
  })
})
