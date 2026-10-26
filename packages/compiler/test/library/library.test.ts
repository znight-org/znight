/**
 * Compiled provider libraries (§6.4): library mode emits `dist/znight.providers.json` (package
 * identities, import routes, injection points, interceptors, extension data), and applications
 * merge it before binding (library dependencies validated against application providers).
 */
import type { ZnightMetadata } from '@znight/core'
import type { ArgInfo, BindingHandle, ClassInfo, CompilerExtension, Location } from '../../src/index.ts'
import type { ProvidersFile } from '../../src/library/schema.ts'
import type { TempDir } from '../project/helpers.ts'

import fs from 'node:fs'
import { Application } from '@znight/core'

import { compile, generate } from '../../src/compiler.ts'
import { decodeValue, encodeValue } from '../../src/library/schema.ts'
import { tempApp } from '../analysis/helpers.ts'
import { codesOf, render, stable } from '../codegen/helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

interface Mark {
  readonly cls: ClassInfo
  readonly label: string
  readonly handle: BindingHandle
  readonly ref: ArgInfo['ref']
  readonly location: Location
  readonly values: unknown
}

/** An extension used by the library and the application: stored data crosses the fragment. */
const marks = {
  apiVersion: 1,
  name: 'marks',
  decorators: { '@acme/marks#Mark': { targets: ['class'], params: ['static', 'value'] } },
  analyzeClass(cls, ctx) {
    const decorator = cls.decorators.find(d => d.identity === '@acme/marks#Mark')
    if (!decorator) return
    ctx.store({
      cls,
      label: String(decorator.args[0]?.value),
      handle: ctx.bindInjection({ type: '@acme/marks#Tool' }, { from: cls }),
      ref: decorator.args[1]?.ref,
      location: decorator.location,
      values: { nan: Number.NaN, big: 10n, nested: [undefined, { $znight: 'not a tag' }], when: new Date(5) },
    })
  },
  generate(ctx) {
    return ctx.arr(
      ctx.stored.map(mark =>
        ctx.obj({
          label: mark.label,
          cls: ctx.importValue(mark.cls),
          token: ctx.tokenOf(mark.cls) ?? null,
          tool: ctx.lit((ctx.binding(mark.handle) ?? null) as never),
          ref: mark.ref ? ctx.importValue(mark.ref) : null,
          line: mark.location.line,
        }),
      ),
    )
  },
} satisfies CompilerExtension<Mark>

const MARKS_PACKAGE = {
  'node_modules/@acme/marks/package.json': JSON.stringify({
    name: '@acme/marks',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
    znight: { apiVersion: 1, provides: [{ export: 'Tool', plugin: 'MarksPlugin' }] },
  }),
  'node_modules/@acme/marks/index.d.ts':
    'export declare function Mark(label: string, ref?: unknown): ClassDecorator\nexport declare class Tool {\n  readonly name: string\n}\n',
  'node_modules/@acme/marks/index.js': "export const Mark = () => () => {}\nexport class Tool {\n  name = 'tool'\n}\n",
}

const LIBRARY_SOURCES = {
  'src/index.ts': [
    "export * from './clock.ts'",
    "export * from './jwt.ts'",
    "export * from './signer.ts'",
    "export * from './factory.ts'",
    "export * from './audit.ts'",
    '',
  ].join('\n'),
  'src/clock.ts': 'export interface Clock {\n  now(): number\n}\n',
  'src/audit.ts': `import type { MethodInterceptor, MethodInvocation } from '@znight/core'
export const AUDIT_LOG: string[] = []
export class AuditInterceptor implements MethodInterceptor<{ level: string }> {
  intercept(invocation: MethodInvocation, options: { level: string }): unknown {
    AUDIT_LOG.push(\`\${options.level}:\${invocation.methodName}\`)
    return invocation.proceed()
  }
}
`,
  'src/signer.ts': `import { Injectable } from '@znight/core'
export abstract class Signer {
  abstract sign(value: string): string
}
@Injectable()
export class HmacSigner extends Signer {
  sign(value: string): string {
    return \`hmac(\${value})\`
  }
}
`,
  'src/factory.ts': `import { Factory, Provides } from '@znight/core'
export class KeyStore {
  readonly keys: readonly string[]
  constructor(keys: readonly string[]) {
    this.keys = keys
  }
  close(): void {}
}
@Factory()
export class AuthFactory {
  @Provides({ name: 'issuer' })
  issuer(): string {
    return 'acme'
  }
  @Provides({ dispose: 'close' })
  async keys(): Promise<KeyStore> {
    return new KeyStore(['k1'])
  }
}
`,
  'src/jwt.ts': `import { Inject, Injectable, Intercept, type OnStart } from '@znight/core'
import { Mark } from '@acme/marks'
import { AuditInterceptor } from './audit.ts'
import type { Clock } from './clock.ts'
import { KeyStore } from './factory.ts'
import { Signer } from './signer.ts'

export const OPTIONS = Object.freeze({ level: 'debug' })

@Injectable()
@Mark('jwt', OPTIONS)
export class JwtService implements OnStart {
  constructor(
    readonly clock: Clock,
    @Inject('secret') readonly secret: string,
    readonly signers: Signer[],
    readonly keys: KeyStore,
    @Inject('issuer') readonly issuer: string,
  ) {}

  onStart(): void {}

  @Intercept(AuditInterceptor, { level: 'info' })
  sign(subject: string): string {
    return this.signers.map(signer => signer.sign(\`\${subject}@\${this.clock.now()}:\${this.secret}\`)).join('|')
  }
}
`,
}

/** The JavaScript and declarations a build of the library would publish (decorators stripped). */
const LIBRARY_DIST = {
  'dist/index.js': `export const AUDIT_LOG = []
export class AuditInterceptor {
  intercept(invocation, options) {
    AUDIT_LOG.push(\`\${options.level}:\${invocation.methodName}\`)
    return invocation.proceed()
  }
}
export class Signer {}
export class HmacSigner extends Signer {
  sign(value) {
    return \`hmac(\${value})\`
  }
}
export class KeyStore {
  constructor(keys) {
    this.keys = keys
  }
  close() {
    AUDIT_LOG.push('closed')
  }
}
export class AuthFactory {
  issuer() {
    return 'acme'
  }
  async keys() {
    return new KeyStore(['k1'])
  }
}
export const OPTIONS = Object.freeze({ level: 'debug' })
export class JwtService {
  constructor(clock, secret, signers, keys, issuer) {
    Object.assign(this, { clock, secret, signers, keys, issuer })
  }
  onStart() {}
  sign(subject) {
    return this.signers.map(signer => signer.sign(\`\${subject}@\${this.clock.now()}:\${this.secret}\`)).join('|')
  }
}
`,
  'dist/index.d.ts': `import type { MethodInterceptor, MethodInvocation, OnStart } from '@znight/core'
export interface Clock {
  now(): number
}
export declare const AUDIT_LOG: string[]
export declare class AuditInterceptor implements MethodInterceptor<{ level: string }> {
  intercept(invocation: MethodInvocation, options: { level: string }): unknown
}
export declare abstract class Signer {
  abstract sign(value: string): string
}
export declare class HmacSigner extends Signer {
  sign(value: string): string
}
export declare class KeyStore {
  readonly keys: readonly string[]
  constructor(keys: readonly string[])
  close(): void
}
export declare class AuthFactory {
  issuer(): string
  keys(): Promise<KeyStore>
}
export declare const OPTIONS: { readonly level: 'debug' }
export declare class JwtService implements OnStart {
  readonly clock: Clock
  readonly secret: string
  readonly signers: Signer[]
  readonly keys: KeyStore
  readonly issuer: string
  constructor(clock: Clock, secret: string, signers: Signer[], keys: KeyStore, issuer: string)
  onStart(): void
  sign(subject: string): string
}
`,
}

function libraryPackage(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: '@acme/auth',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { 'acme-source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies: { '@acme/marks': '1.0.0', '@znight/core': '0.1.0' },
    znight: { apiVersion: 1, providers: './dist/znight.providers.json' },
    ...extra,
  })
}

const APP_SOURCES = {
  'src/app.ts': `import { Factory, Inject, Injectable, Provides } from '@znight/core'
import { type Clock, JwtService, Signer } from '@acme/auth'
import { Mark } from '@acme/marks'

@Injectable()
export class SystemClock implements Clock {
  now(): number {
    return 7
  }
}

@Injectable()
export class RsaSigner extends Signer {
  sign(value: string): string {
    return \`rsa(\${value})\`
  }
}

@Factory()
export class Secrets {
  @Provides({ name: 'secret' })
  secret(): string {
    return 's3cr3t'
  }
}

@Injectable()
@Mark('login')
export class Login {
  constructor(
    readonly jwt: JwtService,
    @Inject('issuer') readonly issuer: string,
  ) {}
}
`,
}

describe('compiled provider libraries', () => {
  let library: TempDir
  let app: TempDir
  let fragment: ProvidersFile

  beforeAll(() => {
    library = tempApp({ ...MARKS_PACKAGE, ...LIBRARY_SOURCES })
    library.write('package.json', libraryPackage())
    app = tempApp({ ...MARKS_PACKAGE, ...APP_SOURCES })
    app.write(
      'package.json',
      JSON.stringify({
        name: 'acme-app',
        private: true,
        type: 'module',
        dependencies: { '@acme/auth': '1.0.0', '@acme/marks': '1.0.0', '@znight/core': '0.1.0' },
      }),
    )
    fs.symlinkSync(library.root, `${app.root}/node_modules/@acme/auth`, 'dir')
  })
  afterAll(() => {
    app.cleanup()
    library.cleanup()
  })

  it('emits znight.providers.json in library mode', async () => {
    const options = {
      root: library.root,
      library: true,
      conditions: ['acme-source'],
      extensions: [marks],
      mode: 'build',
    } as const
    const result = await generate(options)
    expect(
      render(
        library.root,
        result.diagnostics.filter(d => d.severity === 'error'),
      ),
    ).toBe('')
    expect(codesOf(library.root, result.diagnostics)).toEqual(['ZNIGHT001 src/jwt.ts:14', 'ZNIGHT001 src/jwt.ts:15'])
    expect(result.diagnostics[0]?.severity).toBe('warning')
    expect(result.diagnostics[0]?.hints?.at(-1)).toContain('the applications using this library must provide it')
    const file = `${library.root}/dist/znight.providers.json`
    expect(result.written).toContain(file)
    expect(result.library?.file).toBe(file)
    // check mode names the stale generated files: here only the manifest (a build cleaned dist/)
    const content = fs.readFileSync(file, 'utf8')
    const checkOptions = { ...options, check: true }
    expect(await generate(checkOptions)).toMatchObject({ stale: false, staleFiles: [] })
    fs.rmSync(file)
    try {
      expect(await generate(checkOptions)).toMatchObject({ stale: true, staleFiles: [file] })
      fs.rmSync(result.outFile)
      expect(await generate(checkOptions)).toMatchObject({ stale: true, staleFiles: [result.outFile, file] })
    } finally {
      fs.writeFileSync(file, content)
      fs.writeFileSync(result.outFile, result.diskCode)
    }
    fragment = JSON.parse(fs.readFileSync(file, 'utf8')) as ProvidersFile
    expect(fragment.schemaVersion).toBe(1)
    expect(fragment.package).toBe('@acme/auth')
    expect(fragment.providers.map(provider => provider.token)).toEqual([
      '@acme/auth#AuditInterceptor',
      '@acme/auth#AuthFactory',
      '@acme/auth#AuthFactory.issuer',
      '@acme/auth#AuthFactory.keys',
      '@acme/auth#HmacSigner',
      '@acme/auth#JwtService',
    ])
    const jwt = fragment.providers.find(provider => provider.token === '@acme/auth#JwtService')
    expect(jwt).toMatchObject({
      kind: 'class',
      class: '@acme/auth#JwtService',
      importRoute: { specifier: '@acme/auth', exportName: 'JwtService', members: [] },
      scope: 'singleton',
      registeredBy: 'core',
      lifecycle: ['onStart'],
      interceptors: [
        {
          method: 'sign',
          async: false,
          chain: [
            { token: '@acme/auth#AuditInterceptor', decorator: '@znight/core#Intercept', options: { level: 'info' } },
          ],
        },
      ],
    })
    expect(jwt?.params.map(param => [param.type, param.qualifier, param.label])).toEqual([
      [
        { kind: 'reference', identity: '@acme/auth#Clock', name: 'Clock', typeArgs: [] },
        undefined,
        "parameter 'clock' of JwtService",
      ],
      [{ kind: 'primitive', name: 'string' }, 'secret', "parameter 'secret' of JwtService"],
      [
        { kind: 'array', element: { kind: 'reference', identity: '@acme/auth#Signer', name: 'Signer', typeArgs: [] } },
        undefined,
        "parameter 'signers' of JwtService",
      ],
      [
        { kind: 'reference', identity: '@acme/auth#KeyStore', name: 'KeyStore', typeArgs: [] },
        undefined,
        "parameter 'keys' of JwtService",
      ],
      [{ kind: 'primitive', name: 'string' }, 'issuer', "parameter 'issuer' of JwtService"],
    ])
    const keys = fragment.providers.find(provider => provider.token === '@acme/auth#AuthFactory.keys')
    expect(keys).toMatchObject({
      kind: 'provides',
      method: 'keys',
      async: true,
      dispose: 'close',
      class: '@acme/auth#AuthFactory',
    })
    expect(fragment.providers.find(provider => provider.token === '@acme/auth#HmacSigner')?.heritage).toEqual([
      { kind: 'reference', identity: '@acme/auth#Signer', name: 'Signer', typeArgs: [] },
    ])
    expect(fragment.providers.find(provider => provider.token === '@acme/auth#AuditInterceptor')?.registeredBy).toBe(
      'auto',
    )
    expect(fragment.bindings).toEqual([
      {
        id: 1,
        type: { kind: 'reference', identity: '@acme/marks#Tool', name: 'Tool', typeArgs: [] },
        label: "injection of 'Tool' (extension 'marks')",
        from: '@acme/auth#JwtService',
      },
    ])
    expect(fragment.edges).toEqual([
      { from: '@acme/auth#JwtService', to: '@acme/marks#Tool', reason: "injection of 'Tool' (extension 'marks')" },
    ])
    expect(fragment.extensions.marks).toEqual([
      {
        cls: { $znight: 'class', identity: '@acme/auth#JwtService' },
        label: 'jwt',
        handle: { $znight: 'binding', id: 1 },
        ref: { $znight: 'ref', identity: '@acme/auth#OPTIONS' },
        location: {
          $znight: 'location',
          file: 'src/jwt.ts',
          line: 11,
          column: 1,
          endLine: 11,
          endColumn: 22,
          start: expect.any(Number),
          end: expect.any(Number),
        },
        values: {
          nan: { $znight: 'number', value: 'NaN' },
          big: { $znight: 'bigint', value: '10' },
          nested: [{ $znight: 'undefined' }, { $znight: 'object', value: { $znight: 'not a tag' } }],
          when: { $znight: 'date', value: 5 },
        },
      },
    ])
    expect(
      (
        await generate({
          root: library.root,
          library: true,
          conditions: ['acme-source'],
          extensions: [marks],
          mode: 'build',
          check: true,
        })
      ).stale,
    ).toBe(false)
  })

  it('merges the library into the application and runs it', async () => {
    for (const [file, content] of Object.entries(LIBRARY_DIST)) {
      library.write(file, content)
    }
    const result = await generate({ root: app.root, extensions: [marks] })
    expect(render(app.root, result.diagnostics)).toBe('')
    expect(result.code).toContain(
      "import { AuditInterceptor, AuthFactory, HmacSigner, JwtService, OPTIONS } from '@acme/auth'",
    )
    expect(result.code).toContain("{ multi: ['@acme/auth#HmacSigner', 'src/app.ts#RsaSigner'] }")
    expect(stable(result.code)).toMatchSnapshot()
    expect(result.watchFiles).toContain(`${library.root}/dist/znight.providers.json`)
    expect(result.watchFiles).toContain(`${library.root}/package.json`)

    const metadata = (await import(result.outFile)).__ZNIGHT_METADATA__ as ZnightMetadata
    const tool = { name: 'tool' }
    const application = await Application.create({
      metadata,
      providers: [['@acme/marks#Tool', tool]],
      shutdown: { signals: false },
    })
    // biome-ignore lint/suspicious/noExplicitAny: fixture instances are untyped
    const login = application.container.get('src/app.ts#Login') as any
    expect(login.issuer).toBe('acme')
    expect(login.jwt.keys.keys).toEqual(['k1'])
    expect(login.jwt.sign('ada')).toBe('hmac(ada@7:s3cr3t)|rsa(ada@7:s3cr3t)')
    const dist = await import(`${library.root}/dist/index.js`)
    expect(dist.AUDIT_LOG).toEqual(['info:sign'])

    const section = metadata.extensions?.marks as {
      label: string
      token: string
      tool: unknown
      ref: unknown
      line: number
    }[]
    expect(section.map(mark => mark.label)).toEqual(['login', 'jwt'])
    expect(section[1]).toMatchObject({
      token: '@acme/auth#JwtService',
      tool: '@acme/marks#Tool',
      ref: dist.OPTIONS,
      line: 11,
    })
    expect(section[0]).toMatchObject({ token: 'src/app.ts#Login', tool: '@acme/marks#Tool', ref: null })
    await application.stop()
    expect(dist.AUDIT_LOG).toEqual(['info:sign', 'closed'])
  })

  it('validates the library dependencies against the application providers', async () => {
    const original = fs.readFileSync(`${app.root}/src/app.ts`, 'utf8')
    try {
      app.write(
        'src/app.ts',
        original.replace('implements Clock', '').replace("@Provides({ name: 'secret' })", '@Provides()'),
      )
      const result = await compile({ root: app.root, extensions: [marks] })
      expect(result.ok).toBe(false)
      expect(render(app.root, result.diagnostics)).toContain("Missing provider for 'Clock' required by JwtService")
      expect(render(app.root, result.diagnostics)).toContain(
        "Missing provider for 'secret' (string) required by JwtService",
      )
    } finally {
      app.write('src/app.ts', original)
    }
  })

  it('reports unreadable fragments, unsupported schema versions and unknown extensions', async () => {
    const file = `${library.root}/dist/znight.providers.json`
    const original = fs.readFileSync(file, 'utf8')
    try {
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), schemaVersion: 2 }))
      const version = await compile({ root: app.root, extensions: [marks] })
      expect(render(app.root, version.diagnostics)).toContain(
        'Compiled provider library @acme/auth (@acme/auth/dist/znight.providers.json): unsupported schemaVersion 2 (expected 1)',
      )
      fs.writeFileSync(file, '{ nope')
      const broken = await compile({ root: app.root, extensions: [marks] })
      expect(render(app.root, broken.diagnostics)).toContain('znight.providers.json): cannot be read')
      fs.writeFileSync(file, original)
      const withoutExtension = await compile({ root: app.root })
      expect(render(app.root, withoutExtension.diagnostics)).toContain(
        "contains data of the compiler extension 'marks', which is not loaded",
      )
    } finally {
      fs.writeFileSync(file, original)
    }
  })

  it('reports malformed or version-skewed fragment entries (ZNIGHT018) instead of crashing', async () => {
    const file = `${library.root}/dist/znight.providers.json`
    const original = fs.readFileSync(file, 'utf8')
    const fragment = JSON.parse(original) as {
      providers: Record<string, unknown>[]
      edges: unknown[]
      bindings: unknown[]
      extensions: Record<string, unknown>
    }
    const [first, ...others] = fragment.providers as [Record<string, unknown>, ...Record<string, unknown>[]]
    const variants: [string, unknown, string][] = [
      [
        'provider without lifecycle',
        { ...fragment, providers: [{ ...first, lifecycle: undefined }, ...others] },
        `malformed provider #0: "lifecycle" must be an array of strings`,
      ],
      [
        'unknown encoded tag',
        { ...fragment, providers: [{ ...first, providedType: { $znight: 'future' } }, ...others] },
        `malformed provider ${first['token']} (unknown encoded value tag "future")`,
      ],
      [
        'bad bigint',
        { ...fragment, providers: [{ ...first, providedType: { $znight: 'bigint', value: 'x' } }, ...others] },
        `malformed provider ${first['token']}`,
      ],
      [
        'heritage that is not a list of types',
        { ...fragment, providers: [{ ...first, heritage: [42] }, ...others] },
        `malformed provider ${first['token']} (not a type: 42)`,
      ],
      [
        'provider that is not an object',
        { ...fragment, providers: [null, ...fragment.providers] },
        'malformed provider #0: not an object',
      ],
      ['malformed edge', { ...fragment, edges: [{ from: 1 }] }, 'malformed edge #0'],
      ['malformed binding', { ...fragment, bindings: [{ id: 'x' }] }, 'malformed binding #0'],
      [
        'malformed extension data',
        { ...fragment, extensions: { marks: 'nope' } },
        "malformed data of the compiler extension 'marks'",
      ],
    ]
    try {
      for (const [, content, message] of variants) {
        fs.writeFileSync(file, JSON.stringify(content))
        const result = await compile({ root: app.root, extensions: [marks] })
        const rendered = render(app.root, result.diagnostics)
        expect(rendered).toContain(
          `ZNIGHT018: Compiled provider library @acme/auth (@acme/auth/dist/znight.providers.json): ${message}`,
        )
      }
    } finally {
      fs.writeFileSync(file, original)
    }
  })

  it('rejects non-exported providers and custom factories in library mode', async () => {
    library.write('src/hidden.ts', "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Hidden {}\n")
    try {
      const hidden = await compile({
        root: library.root,
        library: true,
        conditions: ['acme-source'],
        extensions: [marks],
      })
      expect(hidden.ok).toBe(false)
      expect(hidden.library).toBeUndefined()
      expect(render(library.root, hidden.diagnostics)).toContain(
        'Class Hidden is not exported by a public entry of @acme/auth',
      )
    } finally {
      library.remove('src/hidden.ts')
    }
    const custom = {
      ...marks,
      name: 'custom',
      analyzeClass(cls, ctx) {
        if (!cls.decorators.some(decorator => decorator.identity === '@znight/core#Injectable')) {
          ctx.registerProvider(cls, { factory: { deps: [], generate: g => g.lit(null) } })
        }
      },
      generate: undefined,
    } satisfies CompilerExtension<Mark>
    library.write('src/custom.ts', "import { Mark } from '@acme/marks'\n@Mark('custom')\nexport class Custom {}\n")
    try {
      const result = await compile({
        root: library.root,
        library: true,
        conditions: ['acme-source'],
        extensions: [custom],
      })
      expect(render(library.root, result.diagnostics)).toContain(
        "Custom has a custom factory (registered by compiler extension 'custom'): compiled provider libraries cannot contain custom factories",
      )
    } finally {
      library.remove('src/custom.ts')
    }
  })
})

describe('providers file value encoding', () => {
  const hooks = {
    ref: () => undefined,
    classInfo: () => undefined,
    binding: () => undefined,
    location: () => undefined,
  }
  const decodeHooks = {
    ref: () => 'REF',
    classInfo: () => 'CLASS',
    binding: () => 'HANDLE',
    location: () => 'LOCATION',
  }

  it('round-trips every literal kind', () => {
    const value = {
      text: 'x',
      number: 1.5,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      ninf: Number.NEGATIVE_INFINITY,
      zero: -0,
      big: -3n,
      none: undefined,
      nil: null,
      regexp: /a\/b/g,
      date: new Date(42),
      list: [1, [true]],
      tagged: { $znight: 'x' },
    }
    const encoded = encodeValue(value, hooks)
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded as never)
    const decoded = decodeValue(JSON.parse(JSON.stringify(encoded)), decodeHooks) as typeof value
    expect(decoded).toEqual(value)
    expect(Object.is(decoded.zero, -0)).toBe(true)
  })

  it('rejects functions, symbols, cycles and class instances', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => encodeValue(() => 1, hooks)).toThrow('functions cannot be stored')
    expect(() => encodeValue(Symbol('x'), hooks)).toThrow('symbols cannot be stored')
    expect(() => encodeValue(cyclic, hooks)).toThrow('cyclic')
    expect(() => encodeValue(new Map(), hooks)).toThrow('an instance of Map cannot be stored')
    expect(() => decodeValue({ $znight: 'mystery' }, decodeHooks)).toThrow('unknown encoded value tag')
  })
})
