/**
 * Analysis of `@Config` classes: provider registration (custom `loadConfig` factory with the
 * `ConfigSource` as an optional dependency), field definitions (§9.3) and ZNIGHT012 / ZNIGHT005
 * diagnostics. See the "Compiler contract" section of the package README.
 */
import type {
  AnalyzeContext,
  ArgInfo,
  ClassInfo,
  DecoratorInfo,
  Diagnostic,
  Location,
  PropertyInfo,
  RelatedInformation,
  StaticValue,
  ValidateContext,
} from '@znight/compiler'
import type { ConfigEnumValue, ConfigFieldType } from '../metadata.ts'
import type { FieldTypeResult } from './field-type.ts'

import { coerceConfigValue, isUnset } from '../coerce.ts'
import { CONFIG_SOURCE_TOKEN, constantCase, defaultEnvName, defaultKeyPath } from '../conventions.ts'
import { FieldTypeResolver } from './field-type.ts'
import { configFactory } from './generate.ts'

/** Canonical identities of the config decorators. */
export const ConfigDecorator: {
  readonly Config: '@znight/config#Config'
  readonly Env: '@znight/config#Env'
  readonly Secret: '@znight/config#Secret'
  readonly Default: '@znight/config#Default'
  readonly Key: '@znight/config#Key'
} = Object.freeze({
  Config: '@znight/config#Config',
  Env: '@znight/config#Env',
  Secret: '@znight/config#Secret',
  Default: '@znight/config#Default',
  Key: '@znight/config#Key',
})

const PROPERTY_DECORATORS: ReadonlySet<string> = new Set([
  ConfigDecorator.Env,
  ConfigDecorator.Secret,
  ConfigDecorator.Default,
  ConfigDecorator.Key,
])

const INVALID_DECORATOR = 'ZNIGHT005'
const INVALID_CONFIG = 'ZNIGHT012'

/** Portable environment variable names (POSIX): letters, digits and `_`, not starting with a digit. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One generated field definition (a `ConfigFieldDefinition` literal). */
export interface ConfigFieldData {
  readonly property: string
  readonly env: string
  readonly key: string
  readonly type: ConfigFieldType
  readonly enum?: readonly ConfigEnumValue[]
  readonly default?: StaticValue
  readonly required: boolean
  readonly secret: boolean
}

/** A `@Config` class (stored for `validate` / `generate`). */
export interface StoredConfig {
  readonly kind: 'config'
  /** Provider token (the class identity). */
  readonly token: string
  readonly displayName: string
  readonly prefix: string | undefined
  /** Fields in declaration order (inherited fields first). */
  readonly fields: readonly ConfigFieldData[]
  /** Identities of the base classes whose properties are fields of this class. */
  readonly bases: readonly string[]
}

/**
 * A class carrying property decorators without `@Config`: valid only as a base class of a config
 * class (checked in `validate`, once every class has been analysed).
 */
export interface StoredOrphan {
  readonly kind: 'orphan'
  readonly identity: string
  readonly displayName: string
  readonly decorators: readonly { readonly name: string; readonly location: Location }[]
}

/** Data stored by the extension. */
export type StoredConfigData = StoredConfig | StoredOrphan

type Reporter = (diagnostic: Diagnostic) => void

/** `analyzeClass` of the config extension. */
export function analyzeConfigClass(cls: ClassInfo, ctx: AnalyzeContext<StoredConfigData>): void {
  const report: Reporter = diagnostic => ctx.report(diagnostic)
  const configDecorators = cls.decorators.filter(decorator => decorator.identity === ConfigDecorator.Config)
  const [config, ...duplicates] = configDecorators
  if (config === undefined) {
    const decorators = cls.properties.flatMap(property => propertyDecorators(property))
    if (decorators.length > 0) {
      ctx.store({
        kind: 'orphan',
        identity: cls.identity,
        displayName: cls.displayName,
        decorators: decorators.map(decorator => ({ name: decorator.name, location: decorator.location })),
      })
    }
    return
  }
  for (const duplicate of duplicates) {
    report(
      error(
        INVALID_DECORATOR,
        `@${duplicate.name} is applied several times to ${cls.displayName}`,
        duplicate.location,
        [`Keep a single @${duplicate.name}`],
      ),
    )
  }

  const prefix = readPrefix(config, report)
  checkConstructor(cls, config, report)
  const resolver = new FieldTypeResolver(ctx.project, ctx.types)
  const chain = inheritanceChain(cls, config, ctx, report)
  const fields = new Map<string, ConfigFieldData>()
  const locations = new Map<string, Location>()
  for (const owner of chain) {
    for (const property of owner.properties) {
      const decorators = propertyDecorators(property)
      if (property.static || property.privateName || property.accessor || property.computed) {
        for (const decorator of decorators) {
          report(
            error(
              INVALID_CONFIG,
              `@${decorator.name} cannot be used on ${describeMember(property)} ${owner.displayName}.${property.name}: config fields are plain instance properties`,
              decorator.location,
              ['Declare a public instance property: `name: string`'],
            ),
          )
        }
        continue
      }
      const field = analyzeField(owner, property, decorators, prefix, resolver, report)
      if (field !== undefined) {
        fields.set(property.name, field)
        locations.set(property.name, property.location)
      }
    }
  }
  checkDuplicates(cls, [...fields.values()], locations, report)

  const data: StoredConfig = {
    kind: 'config',
    token: cls.identity,
    displayName: cls.displayName,
    prefix,
    fields: [...fields.values()],
    bases: chain.slice(0, -1).map(base => base.identity),
  }
  ctx.registerProvider(cls, {
    scope: 'singleton',
    factory: configFactory(data, [
      { type: CONFIG_SOURCE_TOKEN, optional: true, label: `configuration source of ${cls.displayName}` },
    ]),
  })
  ctx.store(data)
}

/** `validate` of the config extension: property decorators outside of config classes. */
export function validateConfigData(ctx: ValidateContext<StoredConfigData>): void {
  const inherited = new Set(ctx.stored.flatMap(data => (data.kind === 'config' ? data.bases : [])))
  for (const data of ctx.stored) {
    if (data.kind !== 'orphan' || inherited.has(data.identity)) {
      continue
    }
    for (const decorator of data.decorators) {
      ctx.report(
        error(
          INVALID_CONFIG,
          `@${decorator.name} can only be used in a @Config class (or a base class of one): ${data.displayName} is not a config class`,
          decorator.location,
          [`Add @Config() to ${data.displayName}`],
        ),
      )
    }
  }
}

// ----------------------------------------------------------------------------------- fields

function analyzeField(
  owner: ClassInfo,
  property: PropertyInfo,
  decorators: readonly DecoratorInfo[],
  prefix: string | undefined,
  resolver: FieldTypeResolver,
  report: Reporter,
): ConfigFieldData | undefined {
  const where = `${owner.displayName}.${property.name}`
  const env = single(decorators, ConfigDecorator.Env, report)
  const secret = single(decorators, ConfigDecorator.Secret, report)
  const defaultDecorator = single(decorators, ConfigDecorator.Default, report)
  const keyDecorator = single(decorators, ConfigDecorator.Key, report)

  // names
  const envArg = env === undefined ? undefined : nameArgument(env, true, report)
  const secretArg = secret === undefined ? undefined : nameArgument(secret, false, report)
  let envName: string | undefined
  if (envArg?.value !== undefined && secretArg?.value !== undefined && envArg.value !== secretArg.value) {
    report(
      error(
        INVALID_CONFIG,
        `${where} has two environment names: @Env('${envArg.value}') and @Secret('${secretArg.value}')`,
        secretArg.location,
        [`Keep a single name: @Secret() @Env('${envArg.value}'), or @Secret('${envArg.value}') alone`],
      ),
    )
  }
  const explicit = envArg?.value === undefined ? secretArg : envArg
  if (explicit?.value === undefined) {
    envName = defaultEnvName(prefix, property.name)
    if (!ENV_NAME.test(envName)) {
      report(
        error(
          INVALID_CONFIG,
          `The default environment variable name of ${where} is invalid (${JSON.stringify(envName)})`,
          property.location,
          ["Name it explicitly: @Env('NAME')"],
        ),
      )
    }
  } else {
    envName = explicit.value
    if (!ENV_NAME.test(envName)) {
      report(
        error(
          INVALID_CONFIG,
          `Invalid environment variable name ${JSON.stringify(envName)} for ${where}`,
          explicit.location,
          ['Environment names contain letters, digits and underscores and do not start with a digit (DATABASE_URL)'],
        ),
      )
    }
  }
  let key = defaultKeyPath(prefix, property.name)
  if (keyDecorator !== undefined) {
    const keyArg = nameArgument(keyDecorator, true, report)
    if (keyArg?.value !== undefined) {
      key = keyArg.value
      if (!isKeyPath(key)) {
        report(
          error(INVALID_CONFIG, `Invalid key path ${JSON.stringify(key)} for ${where}`, keyArg.location, [
            "Key paths are dot-separated non-empty segments ('database.primary.host')",
          ]),
        )
      }
    }
  }

  // default value
  const defaultArg = defaultDecorator === undefined ? undefined : defaultArgument(defaultDecorator, report)

  // type
  let resolved: FieldTypeResult | undefined
  let nullable = false
  if (property.type === undefined) {
    resolved = inferType(property, defaultArg, resolver)
    if (resolved === undefined) {
      report(
        error(
          INVALID_CONFIG,
          `The type of the config property ${where} is unknown: add a type annotation`,
          property.location,
          [`Annotate it: \`${property.name}: string\` (or number, boolean, string[], URL...)`],
        ),
      )
      return undefined
    }
  } else {
    const annotated = resolver.resolve(property.type)
    nullable = annotated.nullable
    resolved = annotated.result
  }
  if (!resolved.ok) {
    report(
      error(
        INVALID_CONFIG,
        `Unsupported type for the config property ${where}: ${resolved.reason}`,
        property.location,
        resolved.hints,
      ),
    )
    return undefined
  }
  const { type } = resolved
  const allowed = resolved.enum

  let hasDefault = defaultArg !== undefined
  if (defaultArg?.evaluated === true) {
    hasDefault = checkDefault(where, defaultArg, type, allowed, secret !== undefined, report)
  }
  const required = !(property.optional || nullable || hasDefault || property.initializer !== undefined)
  return {
    property: property.name,
    env: envName,
    key,
    type,
    ...(allowed === undefined ? {} : { enum: allowed }),
    ...(defaultArg?.evaluated === true && hasDefault ? { default: defaultArg.value } : {}),
    required,
    secret: secret !== undefined,
  }
}

/** Type of a property without annotation, inferred from its initializer or `@Default` value. */
function inferType(
  property: PropertyInfo,
  defaultArg: ArgInfo | undefined,
  resolver: FieldTypeResolver,
): FieldTypeResult | undefined {
  const initializer = property.initializer
  if (initializer !== undefined) {
    if (initializer.evaluated) {
      return resolver.infer(initializer.value)
    }
    const node = initializer.node as { readonly type: string; readonly callee?: { type: string; name?: string } }
    if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'URL') {
      return { ok: true, type: 'url', enum: undefined }
    }
    return undefined
  }
  return defaultArg?.evaluated === true ? resolver.infer(defaultArg.value) : undefined
}

/** Checks a `@Default` value against the field type; returns whether it provides a value. */
function checkDefault(
  where: string,
  arg: ArgInfo,
  type: ConfigFieldType,
  allowed: readonly ConfigEnumValue[] | undefined,
  secret: boolean,
  report: Reporter,
): boolean {
  if (isUnset(arg.value, type)) {
    report(
      error(
        INVALID_CONFIG,
        `@Default(${arg.text}) of ${where} has no effect: ${arg.value === undefined || arg.value === null ? 'it is not a value' : `a blank string is not a ${type} value`}`,
        arg.location,
        ['Remove @Default and make the property optional (`name?: T`) instead'],
      ),
    )
    return false
  }
  const result = coerceConfigValue(arg.value, type, { enum: allowed, secret })
  if (!result.ok) {
    report(
      error(INVALID_CONFIG, `Invalid @Default value for ${where} (${type}): ${result.message}`, arg.location, [
        `Use a value of the type of ${where}`,
      ]),
    )
  }
  return true
}

function checkDuplicates(
  cls: ClassInfo,
  fields: readonly ConfigFieldData[],
  locations: ReadonlyMap<string, Location>,
  report: Reporter,
): void {
  for (const [what, select] of [
    ['environment variable', (field: ConfigFieldData) => field.env],
    ['key path', (field: ConfigFieldData) => field.key],
  ] as const) {
    const seen = new Map<string, ConfigFieldData>()
    for (const field of fields) {
      const name = select(field)
      const first = seen.get(name)
      if (first === undefined) {
        seen.set(name, field)
        continue
      }
      const location = locations.get(field.property) as Location
      const related: RelatedInformation[] = [
        { message: `'${first.property}' reads ${name}`, location: locations.get(first.property) as Location },
      ]
      report(
        error(
          INVALID_CONFIG,
          `The config properties '${first.property}' and '${field.property}' of ${cls.displayName} read the same ${what} ${JSON.stringify(name)}`,
          location,
          [`Give each property its own ${what === 'key path' ? 'key path (@Key)' : 'name (@Env)'}`],
          related,
        ),
      )
    }
  }
}

// ---------------------------------------------------------------------------------- classes

/** Static `@Config(prefix?)` argument (`undefined` without prefix or when invalid). */
function readPrefix(decorator: DecoratorInfo, report: Reporter): string | undefined {
  const arg = decorator.args[0]
  if (arg === undefined || !arg.evaluated || arg.value === undefined) {
    return undefined
  }
  if (typeof arg.value !== 'string') {
    report(
      error(INVALID_DECORATOR, `The prefix of @${decorator.name} must be a string (got ${arg.text})`, arg.location, [
        `Write @${decorator.name}('database'), or @${decorator.name}() without prefix`,
      ]),
    )
    return undefined
  }
  const prefix = arg.value
  const scope = constantCase(prefix)
  if (prefix === '' || !isKeyPath(prefix) || !ENV_NAME.test(scope)) {
    report(
      error(
        INVALID_CONFIG,
        `Invalid prefix ${JSON.stringify(prefix)} for @${decorator.name}: ${prefix === '' ? 'it is empty' : `it gives the environment names ${JSON.stringify(`${scope}_*`)} and the key paths ${JSON.stringify(`${prefix}.*`)}`}`,
        arg.location,
        [
          prefix === ''
            ? `Omit the prefix: @${decorator.name}()`
            : "Use an identifier-like prefix ('database', 'http.server')",
        ],
      ),
    )
    return undefined
  }
  return prefix
}

/** Config classes are created with `new Class()`: no required constructor parameter. */
function checkConstructor(cls: ClassInfo, config: DecoratorInfo, report: Reporter): void {
  const ctor = cls.ctor
  if (ctor.error !== undefined) {
    return
  }
  const location = ctor.declaredBy === cls.identity && ctor.location !== undefined ? ctor.location : config.location
  const required = ctor.params.filter(param => !param.optional && !param.hasDefault && !param.rest)
  if (required.length > 0) {
    report(
      error(
        INVALID_CONFIG,
        `The config class ${cls.displayName} has a constructor with required parameters (${required.map(param => param.name).join(', ')}): config classes are created without arguments`,
        location,
        ['Remove the constructor parameters: inject the config class into the providers that need it instead'],
      ),
    )
  }
  if (ctor.visibility !== 'public') {
    report(
      error(
        INVALID_CONFIG,
        `The constructor of the config class ${cls.displayName} is ${ctor.visibility}: the generated module cannot instantiate it`,
        location,
        ['Make the constructor public'],
      ),
    )
  }
}

/**
 * The class and its analysable base classes, root first: inherited properties are fields too.
 * Properties of base classes from declaration files cannot be analysed (initializers are erased).
 */
function inheritanceChain(
  cls: ClassInfo,
  config: DecoratorInfo,
  ctx: AnalyzeContext<StoredConfigData>,
  report: Reporter,
): ClassInfo[] {
  const chain = [cls]
  const seen = new Set([cls.identity])
  let current = cls
  while (current.superClass !== undefined) {
    const base = ctx.classInfo(current.superClass.identity)
    if (base === undefined || seen.has(base.identity)) {
      break
    }
    seen.add(base.identity)
    if (base.ambient) {
      if (base.properties.some(property => !property.static && !property.privateName)) {
        report({
          code: INVALID_CONFIG,
          severity: 'warning',
          message: `The properties inherited by ${cls.displayName} from ${base.displayName} (declared in ${base.relativeFile}) are not configuration fields: declaration files do not tell which properties have initializers`,
          location: config.location,
          hints: [`Redeclare the properties to load in ${cls.displayName}`],
        })
      }
      break
    }
    chain.unshift(base)
    current = base
  }
  return chain
}

// ---------------------------------------------------------------------------------- helpers

/** Config property decorators of a property (decorators applied to the right target only). */
function propertyDecorators(property: PropertyInfo): DecoratorInfo[] {
  return property.decorators.filter(
    decorator =>
      decorator.identity !== undefined &&
      PROPERTY_DECORATORS.has(decorator.identity) &&
      decorator.target === 'property',
  )
}

function single(decorators: readonly DecoratorInfo[], identity: string, report: Reporter): DecoratorInfo | undefined {
  const found = decorators.filter(decorator => decorator.identity === identity)
  for (const duplicate of found.slice(1)) {
    report(
      error(INVALID_DECORATOR, `@${duplicate.name} is applied several times`, duplicate.location, [
        `Keep a single @${duplicate.name}`,
      ]),
    )
  }
  return found[0]
}

/** A static string argument: `value` is `undefined` when absent or invalid (already reported). */
function nameArgument(
  decorator: DecoratorInfo,
  required: boolean,
  report: Reporter,
): { readonly value: string | undefined; readonly location: Location } | undefined {
  const arg = decorator.args[0]
  if (arg === undefined) {
    if (required && decorator.called) {
      const example = decorator.identity === ConfigDecorator.Key ? "'database.host'" : "'NAME'"
      report(
        error(INVALID_DECORATOR, `@${decorator.name} requires an argument`, decorator.location, [
          `Write @${decorator.name}(${example})`,
        ]),
      )
    }
    return undefined
  }
  if (!arg.evaluated) {
    return undefined
  }
  if (arg.value === undefined && !required) {
    return { value: undefined, location: arg.location }
  }
  if (typeof arg.value !== 'string') {
    report(
      error(INVALID_DECORATOR, `The argument of @${decorator.name} must be a string (got ${arg.text})`, arg.location),
    )
    return undefined
  }
  return { value: arg.value, location: arg.location }
}

function defaultArgument(decorator: DecoratorInfo, report: Reporter): ArgInfo | undefined {
  const arg = decorator.args[0]
  if (arg === undefined && decorator.called) {
    report(
      error(INVALID_DECORATOR, `@${decorator.name} requires a value`, decorator.location, [
        `Write @${decorator.name}(value), or remove it`,
      ]),
    )
  }
  return arg
}

function isKeyPath(path: string): boolean {
  return path !== '' && path.split('.').every(segment => segment !== '')
}

function describeMember(property: PropertyInfo): string {
  if (property.static) {
    return 'the static property'
  }
  if (property.privateName) {
    return 'the #private property'
  }
  if (property.accessor) {
    return 'the accessor'
  }
  return 'the computed property'
}

function error(
  code: typeof INVALID_CONFIG | typeof INVALID_DECORATOR,
  message: string,
  location: Location,
  hints?: readonly string[],
  related?: readonly RelatedInformation[],
): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    location,
    ...(hints === undefined ? {} : { hints }),
    ...(related === undefined ? {} : { related }),
  }
}
