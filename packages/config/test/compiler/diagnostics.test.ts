/**
 * Diagnostics of the config compiler extension: ZNIGHT012 (invalid config classes and properties)
 * and ZNIGHT005 (decorator targets and arguments).
 */
import type { AnalysisResult, Diagnostic } from '@znight/compiler'
import type { TempApp } from './helpers.ts'

import { analyzeApp, render, storedConfigs, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const SUPPORTED =
  '  = hint: Supported types: string, number, boolean, literal unions and enums, string[], number[], URL, and JSON types (interfaces, object types, Record, unknown)'

const FILES: Record<string, string> = {
  'src/types.ts': `
export class Point { x = 0 }
export enum Mixed { A = 1, B = 'b' }
export enum Num { A, B }
`,
  'src/vendor/base.d.ts': 'export declare class VendorBase { region: string; static x: number }\n',
  'src/vendor/base.js': 'export class VendorBase {}\n',
  'src/types-config.ts': `
import { Config } from '@znight/config'
import { Mixed, Num, Point } from './types.ts'
@Config('t')
export class TypesConfig {
  date!: Date
  big!: bigint
  fn!: () => void
  mixed!: string | number
  bools!: boolean[]
  urls!: URL[]
  point!: Point
  map!: Map<string, string>
  sym!: symbol
  promise!: Promise<string>
  mixedEnum!: Mixed
  num!: Num
  untyped
  computed = Number.parseInt('1', 10)
  empty = []
  nothing = null
  lit: 1n = 1n
  inter!: string & number
}
`,
  'src/members.ts': `
import { Config, Default, Env, Key, Secret } from '@znight/config'
@Config()
export class MembersConfig {
  @Env('A') static a = 1
  @Secret() #b = 2
  @Key('c') accessor c = 3
  @Env('X') one!: string
  @Env('X') two!: string
  @Key('k') three!: string
  @Key('k') four!: string
  @Secret('S1') @Env('S2') five!: string
  @Env('1BAD') six!: string
  @Env('my-var') seven!: string
  _ = 'x'
  @Key('a..b') eight!: string
  @Key('') nine!: string
}
`,
  'src/defaults.ts': `
import { Config, Default, Secret } from '@znight/config'
@Config()
export class DefaultsConfig {
  @Default('x') ten!: number
  @Default('maybe') eleven!: boolean
  @Default('prod') twelve!: 'dev' | 'staging'
  @Default(null) thirteen!: string
  @Default('  ') fourteen!: number
  @Secret() @Default(42) fifteen!: string[]
  @Secret() @Default('not-json') sixteen!: unknown
  @Default('localhost:5432') seventeen!: URL
  @Default(['a', 'c']) eighteen!: ('a' | 'b')[]
  @Default('') blank!: string
  @Default('42') numeric!: number
}
`,
  'src/arguments.ts': `
import { Config, Default, Env, Key, Secret } from '@znight/config'
@Config()
export class ArgumentsConfig {
  @Env() a!: string
  @Env(42) b!: string
  @Default() c!: string
  @Env('A1') @Env('A2') d!: string
  @Env(process.env.X) e!: string
  @Key(1) f!: string
  @Secret(1) g!: string
  @Key() h!: string
  @Secret(undefined) i!: string
}
`,
  'src/classes.ts': `
import { Injectable } from '@znight/core'
import { Config, Env, Key } from '@znight/config'
import { VendorBase } from './vendor/base.js'

export class NotConfig {
  @Env('X') x!: string
}

export abstract class UsedBase {
  @Env('Y') y!: string
}

@Config('')
export class EmptyPrefix extends UsedBase {}

@Config('2fa')
export class DigitPrefix {}

@Config(42)
export class NumberPrefix {}

@Config('a..b')
export class DotsPrefix {}

@Config() @Config('x')
export class Twice {}

@Config
export class Uncalled {}

@Config()
export class WithDeps {
  constructor(readonly name: string, readonly other?: number) {}
}

@Config()
export class PrivateCtor {
  private constructor() {}
}

@Config() @Injectable()
export class Both {}

@Config()
export class Vendor extends VendorBase {}

@Config()
class NotExported {}

@Config()
export abstract class AbstractConfig {}

@Config()
export class Generic<T> { value?: T }

export class Targets {
  @Config() prop!: string
  @Env('M') method(@Key('p') p: string): void {}
}
`,
}

describe('diagnostics', () => {
  let app: TempApp
  let result: AnalysisResult

  beforeAll(async () => {
    app = tempApp(FILES)
    result = await analyzeApp(app.root)
  })
  afterAll(() => app.cleanup())

  const of = (file: string): string[] =>
    render(
      app.root,
      result.diagnostics.filter((diagnostic: Diagnostic) => diagnostic.location?.file === `${app.root}/${file}`),
    )

  it('reports unsupported and unknown property types (ZNIGHT012)', () => {
    expect(of('src/types-config.ts')).toEqual([
      [
        "error ZNIGHT012 src/types-config.ts:6:3: Unsupported type for the config property TypesConfig.date: 'Date' instances cannot be loaded from configuration",
        '  = hint: Read a string (ISO 8601 date) or a number (timestamp) and convert it where it is used',
        SUPPORTED,
      ].join('\n'),
      [
        "error ZNIGHT012 src/types-config.ts:7:3: Unsupported type for the config property TypesConfig.big: 'bigint' values cannot be loaded from configuration",
        '  = hint: Use a string or a number',
        SUPPORTED,
      ].join('\n'),
      [
        'error ZNIGHT012 src/types-config.ts:8:3: Unsupported type for the config property TypesConfig.fn: functions cannot be loaded from configuration',
        SUPPORTED,
      ].join('\n'),
      [
        "error ZNIGHT012 src/types-config.ts:9:3: Unsupported type for the config property TypesConfig.mixed: the union 'number | string' mixes several kinds of values",
        "  = hint: Use a single type (a literal union such as 'a' | 'b', or a JSON type)",
        SUPPORTED,
      ].join('\n'),
      [
        "error ZNIGHT012 src/types-config.ts:10:3: Unsupported type for the config property TypesConfig.bools: 'boolean[]' is not supported (lists are comma-separated strings or numbers)",
        '  = hint: Use string[] or number[], or a JSON type',
        SUPPORTED,
      ].join('\n'),
      [
        "error ZNIGHT012 src/types-config.ts:11:3: Unsupported type for the config property TypesConfig.urls: 'URL[]' is not supported",
        '  = hint: Use string[] and build the URLs where they are used',
        SUPPORTED,
      ].join('\n'),
      [
        "error ZNIGHT012 src/types-config.ts:12:3: Unsupported type for the config property TypesConfig.point: 'Point' is a class: class instances cannot be created from configuration values",
        '  = hint: Use an interface or a type alias for JSON values (`interface Point { ... }`)',
        SUPPORTED,
      ].join('\n'),
      [
        "error ZNIGHT012 src/types-config.ts:13:3: Unsupported type for the config property TypesConfig.map: 'Map<string, string>' instances cannot be loaded from configuration",
        '  = hint: Use a Record<string, T> (a JSON object) instead',
        SUPPORTED,
      ].join('\n'),
      [
        "error ZNIGHT012 src/types-config.ts:14:3: Unsupported type for the config property TypesConfig.sym: 'symbol' is not a configuration value type",
        SUPPORTED,
      ].join('\n'),
      [
        'error ZNIGHT012 src/types-config.ts:15:3: Unsupported type for the config property TypesConfig.promise: promises cannot be loaded from configuration',
        SUPPORTED,
      ].join('\n'),
      [
        "error ZNIGHT012 src/types-config.ts:16:3: Unsupported type for the config property TypesConfig.mixedEnum: the enum 'Mixed' mixes string and number members",
        '  = hint: Use an enum whose members are all strings or all numbers',
        SUPPORTED,
      ].join('\n'),
      ...['untyped', 'computed', 'empty', 'nothing'].map((name, index) =>
        [
          `error ZNIGHT012 src/types-config.ts:${18 + index}:3: The type of the config property TypesConfig.${name} is unknown: add a type annotation`,
          `  = hint: Annotate it: \`${name}: string\` (or number, boolean, string[], URL...)`,
        ].join('\n'),
      ),
      [
        "error ZNIGHT012 src/types-config.ts:22:3: Unsupported type for the config property TypesConfig.lit: 'bigint' values cannot be loaded from configuration",
        '  = hint: Use a string or a number',
        SUPPORTED,
      ].join('\n'),
      [
        "error ZNIGHT012 src/types-config.ts:23:3: Unsupported type for the config property TypesConfig.inter: the intersection 'number & string' is not a value type",
        SUPPORTED,
      ].join('\n'),
    ])
  })

  it('keeps the valid fields of a class with invalid ones', () => {
    expect(storedConfigs(result).TypesConfig?.fields).toEqual([
      { property: 'num', env: 'T_NUM', key: 't.num', type: 'number', enum: [0, 1], required: true, secret: false },
    ])
  })

  it('reports invalid members, names and duplicates (ZNIGHT012)', () => {
    expect(of('src/members.ts')).toEqual([
      [
        'error ZNIGHT012 src/members.ts:5:3: @Env cannot be used on the static property MembersConfig.a: config fields are plain instance properties',
        '  = hint: Declare a public instance property: `name: string`',
      ].join('\n'),
      [
        'error ZNIGHT012 src/members.ts:6:3: @Secret cannot be used on the #private property MembersConfig.#b: config fields are plain instance properties',
        '  = hint: Declare a public instance property: `name: string`',
      ].join('\n'),
      [
        'error ZNIGHT012 src/members.ts:7:3: @Key cannot be used on the accessor MembersConfig.c: config fields are plain instance properties',
        '  = hint: Declare a public instance property: `name: string`',
      ].join('\n'),
      [
        "error ZNIGHT012 src/members.ts:9:13: The config properties 'one' and 'two' of MembersConfig read the same environment variable \"X\"",
        '  = hint: Give each property its own name (@Env)',
        "  - 'one' reads X (src/members.ts:8:13)",
      ].join('\n'),
      [
        "error ZNIGHT012 src/members.ts:11:13: The config properties 'three' and 'four' of MembersConfig read the same key path \"k\"",
        '  = hint: Give each property its own key path (@Key)',
        "  - 'three' reads k (src/members.ts:10:13)",
      ].join('\n'),
      [
        "error ZNIGHT012 src/members.ts:12:11: MembersConfig.five has two environment names: @Env('S2') and @Secret('S1')",
        "  = hint: Keep a single name: @Secret() @Env('S2'), or @Secret('S2') alone",
      ].join('\n'),
      [
        'error ZNIGHT012 src/members.ts:13:8: Invalid environment variable name "1BAD" for MembersConfig.six',
        '  = hint: Environment names contain letters, digits and underscores and do not start with a digit (DATABASE_URL)',
      ].join('\n'),
      [
        'error ZNIGHT012 src/members.ts:14:8: Invalid environment variable name "my-var" for MembersConfig.seven',
        '  = hint: Environment names contain letters, digits and underscores and do not start with a digit (DATABASE_URL)',
      ].join('\n'),
      [
        'error ZNIGHT012 src/members.ts:15:3: The default environment variable name of MembersConfig._ is invalid ("")',
        "  = hint: Name it explicitly: @Env('NAME')",
      ].join('\n'),
      [
        'error ZNIGHT012 src/members.ts:16:8: Invalid key path "a..b" for MembersConfig.eight',
        "  = hint: Key paths are dot-separated non-empty segments ('database.primary.host')",
      ].join('\n'),
      [
        'error ZNIGHT012 src/members.ts:17:8: Invalid key path "" for MembersConfig.nine',
        "  = hint: Key paths are dot-separated non-empty segments ('database.primary.host')",
      ].join('\n'),
    ])
  })

  it('checks @Default values against the property type, masking secrets (ZNIGHT012)', () => {
    const hint = (name: string): string => `  = hint: Use a value of the type of DefaultsConfig.${name}`
    expect(of('src/defaults.ts')).toEqual([
      [
        'error ZNIGHT012 src/defaults.ts:5:12: Invalid @Default value for DefaultsConfig.ten (number): expected a number but got "x"',
        hint('ten'),
      ].join('\n'),
      [
        'error ZNIGHT012 src/defaults.ts:6:12: Invalid @Default value for DefaultsConfig.eleven (boolean): expected a boolean (true/false, 1/0, yes/no, on/off) but got "maybe"',
        hint('eleven'),
      ].join('\n'),
      [
        'error ZNIGHT012 src/defaults.ts:7:12: Invalid @Default value for DefaultsConfig.twelve (string): expected one of "dev", "staging" but got "prod"',
        hint('twelve'),
      ].join('\n'),
      [
        'error ZNIGHT012 src/defaults.ts:8:12: @Default(null) of DefaultsConfig.thirteen has no effect: it is not a value',
        '  = hint: Remove @Default and make the property optional (`name?: T`) instead',
      ].join('\n'),
      [
        "error ZNIGHT012 src/defaults.ts:9:12: @Default('  ') of DefaultsConfig.fourteen has no effect: a blank string is not a number value",
        '  = hint: Remove @Default and make the property optional (`name?: T`) instead',
      ].join('\n'),
      [
        'error ZNIGHT012 src/defaults.ts:10:22: Invalid @Default value for DefaultsConfig.fifteen (string[]): expected a comma-separated list or an array but got [REDACTED]',
        hint('fifteen'),
      ].join('\n'),
      [
        'error ZNIGHT012 src/defaults.ts:11:22: Invalid @Default value for DefaultsConfig.sixteen (json): expected valid JSON but got [REDACTED]',
        hint('sixteen'),
      ].join('\n'),
      [
        'error ZNIGHT012 src/defaults.ts:12:12: Invalid @Default value for DefaultsConfig.seventeen (url): expected an absolute URL but got "localhost:5432" (missing scheme, e.g. "http://localhost:5432")',
        hint('seventeen'),
      ].join('\n'),
      [
        'error ZNIGHT012 src/defaults.ts:13:12: Invalid @Default value for DefaultsConfig.eighteen (string[]): item 1: expected one of "a", "b" but got "c"',
        hint('eighteen'),
      ].join('\n'),
    ])
    const fields = storedConfigs(result).DefaultsConfig?.fields ?? []
    expect(fields.find(field => field.property === 'blank')).toMatchObject({ default: '', required: false })
    expect(fields.find(field => field.property === 'numeric')).toMatchObject({ default: '42', required: false })
    expect(fields.find(field => field.property === 'thirteen')).toMatchObject({ required: true })
    expect(Object.hasOwn(fields.find(field => field.property === 'thirteen') ?? {}, 'default')).toBe(false)
  })

  it('reports invalid decorator arguments (ZNIGHT005)', () => {
    expect(of('src/arguments.ts')).toEqual([
      ['error ZNIGHT005 src/arguments.ts:5:3: @Env requires an argument', "  = hint: Write @Env('NAME')"].join('\n'),
      'error ZNIGHT005 src/arguments.ts:6:8: The argument of @Env must be a string (got 42)',
      [
        'error ZNIGHT005 src/arguments.ts:7:3: @Default requires a value',
        '  = hint: Write @Default(value), or remove it',
      ].join('\n'),
      ['error ZNIGHT005 src/arguments.ts:8:14: @Env is applied several times', '  = hint: Keep a single @Env'].join(
        '\n',
      ),
      [
        "error ZNIGHT005 src/arguments.ts:9:8: Invalid argument 1 of @Env: it must be statically evaluable ('process' is not declared or imported in this file)",
        '  = hint: Use a literal, or a `const` initialized with a statically evaluable expression',
      ].join('\n'),
      'error ZNIGHT005 src/arguments.ts:10:8: The argument of @Key must be a string (got 1)',
      'error ZNIGHT005 src/arguments.ts:11:11: The argument of @Secret must be a string (got 1)',
      [
        'error ZNIGHT005 src/arguments.ts:12:3: @Key requires an argument',
        "  = hint: Write @Key('database.host')",
      ].join('\n'),
    ])
    const fields = storedConfigs(result).ArgumentsConfig?.fields ?? []
    expect(fields.find(field => field.property === 'a')?.env).toBe('A')
    expect(fields.find(field => field.property === 'd')?.env).toBe('A1')
    expect(fields.find(field => field.property === 'i')).toMatchObject({ env: 'I', secret: true })
  })

  it('reports invalid config classes, prefixes, constructors and targets', () => {
    expect(of('src/classes.ts')).toEqual([
      [
        'error ZNIGHT012 src/classes.ts:7:3: @Env can only be used in a @Config class (or a base class of one): NotConfig is not a config class',
        '  = hint: Add @Config() to NotConfig',
      ].join('\n'),
      [
        'error ZNIGHT012 src/classes.ts:14:9: Invalid prefix "" for @Config: it is empty',
        '  = hint: Omit the prefix: @Config()',
      ].join('\n'),
      [
        'error ZNIGHT012 src/classes.ts:17:9: Invalid prefix "2fa" for @Config: it gives the environment names "2FA_*" and the key paths "2fa.*"',
        "  = hint: Use an identifier-like prefix ('database', 'http.server')",
      ].join('\n'),
      [
        'error ZNIGHT005 src/classes.ts:20:9: The prefix of @Config must be a string (got 42)',
        "  = hint: Write @Config('database'), or @Config() without prefix",
      ].join('\n'),
      [
        'error ZNIGHT012 src/classes.ts:23:9: Invalid prefix "a..b" for @Config: it gives the environment names "A_B_*" and the key paths "a..b.*"',
        "  = hint: Use an identifier-like prefix ('database', 'http.server')",
      ].join('\n'),
      [
        'error ZNIGHT005 src/classes.ts:26:11: @Config is applied several times to Twice',
        '  = hint: Keep a single @Config',
      ].join('\n'),
      ['error ZNIGHT005 src/classes.ts:29:1: @Config must be called: @Config()', '  = hint: Write @Config(...)'].join(
        '\n',
      ),
      [
        'error ZNIGHT012 src/classes.ts:34:3: The config class WithDeps has a constructor with required parameters (name): config classes are created without arguments',
        '  = hint: Remove the constructor parameters: inject the config class into the providers that need it instead',
      ].join('\n'),
      [
        'error ZNIGHT012 src/classes.ts:39:11: The constructor of the config class PrivateCtor is private: the generated module cannot instantiate it',
        '  = hint: Make the constructor public',
      ].join('\n'),
      [
        'error ZNIGHT005 src/classes.ts:42:1: Both is registered by several provider decorators (@Injectable and @Config)',
        '  = hint: A class is a provider of one kind only: keep a single provider decorator',
        '  - first registered with @Injectable (src/classes.ts:42:11)',
      ].join('\n'),
      [
        'warning ZNIGHT012 src/classes.ts:45:1: The properties inherited by Vendor from VendorBase (declared in src/vendor/base.d.ts) are not configuration fields: declaration files do not tell which properties have initializers',
        '  = hint: Redeclare the properties to load in Vendor',
      ].join('\n'),
      [
        "error ZNIGHT005 src/classes.ts:48:1: NotExported must be importable by the generated module to be a provider: 'NotExported' is not exported by src/classes.ts",
        '  = hint: Export it: `export class NotExported ...`',
      ].join('\n'),
      [
        'error ZNIGHT005 src/classes.ts:51:1: @Config cannot register the abstract class AbstractConfig',
        '  = hint: Register a concrete subclass, or provide the value with a @Provides method',
      ].join('\n'),
      [
        'error ZNIGHT005 src/classes.ts:54:1: @Config cannot register the generic class Generic<T>: its type parameters are unbound',
        '  = hint: Subclass it with concrete type arguments (`class UserRepository extends Generic<User> {}`)',
        '  = hint: Or provide it with a @Provides method returning a concrete type',
      ].join('\n'),
      [
        "error ZNIGHT012 src/classes.ts:55:27: Unsupported type for the config property Generic.value: the type parameter 'T' cannot be loaded from configuration",
        '  = hint: Config classes cannot be generic: use a concrete type',
        SUPPORTED,
      ].join('\n'),
      'error ZNIGHT005 src/classes.ts:58:3: @Config cannot be applied to a property (allowed on a class)',
      'error ZNIGHT005 src/classes.ts:59:3: @Env cannot be applied to a method (allowed on a property)',
      'error ZNIGHT005 src/classes.ts:59:20: @Key cannot be applied to a method parameter (allowed on a property)',
    ])
  })

  it('accepts property decorators in a base class of a config class', () => {
    expect(storedConfigs(result).EmptyPrefix?.fields.map(field => field.env)).toEqual(['Y'])
    expect(result.diagnostics.some(diagnostic => diagnostic.message.includes('UsedBase'))).toBe(false)
  })

  it('still registers config classes with errors (no cascading ZNIGHT001)', () => {
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'ZNIGHT001')).toEqual([])
    expect(result.graph.providers.map(provider => provider.displayName)).toContain('WithDeps')
  })

  it('reports nothing else', () => {
    const files = new Set(Object.keys(FILES).map(file => `${app.root}/${file}`))
    expect(result.diagnostics.filter(diagnostic => !files.has(diagnostic.location?.file ?? ''))).toEqual([])
  })
})
