/**
 * Code generation of the config extension (README "Compiler contract"):
 *
 * - the factory of every `@Config` provider: `d => loadConfig(Class, d[0], DatabaseConfig$fields)`;
 * - the `metadata.extensions.config` section: `{ configs: [{ token, prefix?, fields }] }`, ordered
 *   by token;
 * - the field definitions of each class, emitted once as a module-level constant
 *   (`const DatabaseConfig$fields: readonly ConfigFieldDefinition[] = [...]`) referenced by both.
 *
 * When the generation context cannot declare constants (`constant()`), the field definitions are
 * emitted inline at both places (same values).
 */
import type { CustomFactory, GenerateContext, GenNode, InjectionRequest } from '@znight/compiler'
import type { StoredConfig, StoredConfigData } from './analyze.ts'

/** Module of the runtime helpers used by generated code. */
export const CONFIG_MODULE = '@znight/config'

type Context = Pick<GenerateContext, 'lit' | 'code' | 'importFrom' | 'stored'> & {
  readonly constant?: GenerateContext['constant']
}

/** Constant names of the config classes of a compile, by stored array (memoized). */
const constantNames = new WeakMap<readonly unknown[], ReadonlyMap<StoredConfig, string>>()

/**
 * Names of the field constants: `<Class>$fields`, made unique among the config classes of the
 * application (`AppConfig$fields`, `AppConfig$fields$1` in token order) because `constant()`
 * returns the same reference for the same name.
 */
function namesOf(stored: readonly unknown[]): ReadonlyMap<StoredConfig, string> {
  let names = constantNames.get(stored)
  if (names === undefined) {
    const used = new Map<string, number>()
    const result = new Map<StoredConfig, string>()
    for (const config of configsOf(stored)) {
      const base = `${toIdentifier(config.displayName)}$fields`
      const count = used.get(base) ?? 0
      used.set(base, count + 1)
      result.set(config, count === 0 ? base : `${base}$${count}`)
    }
    names = result
    constantNames.set(stored, names)
  }
  return names
}

/**
 * The field definitions of a config class: a reference to the module constant holding them, or the
 * literal itself when constants are not available.
 */
export function fieldsNode(ctx: Context, config: StoredConfig): GenNode {
  const literal = (): GenNode => ctx.lit(config.fields as unknown as Parameters<GenerateContext['lit']>[0])
  const name = typeof ctx.constant === 'function' ? namesOf(ctx.stored).get(config) : undefined
  if (name === undefined || ctx.constant === undefined) {
    return literal()
  }
  const definition = ctx.importFrom(CONFIG_MODULE, 'ConfigFieldDefinition', { type: true })
  return ctx.constant(name, literal(), { type: ctx.code`readonly ${definition}[]` })
}

/** Custom factory of a config class provider: `d => loadConfig(Class, d[0], fields)`. */
export function configFactory(config: StoredConfig, deps: readonly InjectionRequest[]): CustomFactory {
  return {
    deps,
    generate(ctx, input) {
      const loadConfig = ctx.importFrom(CONFIG_MODULE, 'loadConfig')
      return ctx.call(loadConfig, [input.cls, input.deps[0] ?? ctx.lit(undefined), fieldsNode(ctx, config)])
    },
  }
}

/** `metadata.extensions.config`, `undefined` when the application has no config class. */
export function generateConfigSection(ctx: GenerateContext<StoredConfigData>): GenNode | undefined {
  const configs = configsOf(ctx.stored)
  if (configs.length === 0) {
    return undefined
  }
  return ctx.obj({
    configs: ctx.arr(
      configs.map(config =>
        ctx.obj([
          ['token', config.token],
          ...(config.prefix === undefined ? [] : [['prefix', config.prefix] as const]),
          ['fields', fieldsNode(ctx, config)],
        ]),
      ),
    ),
  })
}

/** Config classes of the stored data, ordered by token. */
function configsOf(stored: readonly unknown[]): StoredConfig[] {
  return stored
    .filter(
      (data): data is StoredConfig =>
        typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === 'config',
    )
    .sort((a, b) => compareStrings(a.token, b.token))
}

/** `Models.Inner` → `Models_Inner`: a valid identifier for constant names. */
function toIdentifier(name: string): string {
  const cleaned = name.replace(/[^\w$]/g, '_')
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`
}

/** Code-unit order (never `localeCompare`): deterministic on every platform. */
function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0
  }
  return a < b ? -1 : 1
}
