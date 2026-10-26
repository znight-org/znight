/**
 * Public compiler options (§6.2) and their normalization.
 *
 * `ZnightOptions` is what users pass to `znight()` / `compile()`; {@link normalizeOptions} turns it
 * into a fully-defaulted, validated {@link ResolvedOptions} with absolute POSIX paths, consumed by
 * every compiler phase.
 */
import { realPath, resolvePath } from './project/paths.ts'

/** Extension written in relative import specifiers of the generated module. */
export type ImportExtension = 'js' | 'ts' | 'none'

/** When provider source locations are emitted: in `serve`/`test` only, always, or never. */
export type SourceLocationsMode = 'dev' | 'always' | false

/**
 * Structural shape of a compiler extension as far as options are concerned. The full interface
 * (`analyzeClass`, `validate`, `generate`...) is defined by the extension API (§6.5) and is
 * assignable to this one.
 */
export interface CompilerExtensionLike {
  readonly apiVersion: number
  readonly name: string
}

/** Vite build defaults for a server application (`app` option). */
export interface AppOptions {
  /** Server entry, relative to `root`. Default `'src/main.ts'`. */
  readonly entry?: string
}

/** Options of the Znight compiler (Vite plugin, `compile()`, `generate()`). */
export interface ZnightOptions {
  /** Project root. Default: the Vite root, else `process.cwd()`. */
  readonly root?: string
  /** Globs (relative to `root`) of the application sources to analyse. Default `['src/**\/*.{ts,tsx,mts}']`. */
  readonly include?: readonly string[]
  /**
   * Globs excluded from `include` (and from provider libraries).
   * Default `['**\/*.{test,spec}.*', '**\/*.d.ts', '**\/.znight/**']`. `node_modules`, dot-directories
   * and `outFile` are always excluded.
   */
  readonly exclude?: readonly string[]
  /** Generated module, relative to `root`. Default `'src/.znight/container.generated.ts'`. */
  readonly outFile?: string
  /**
   * tsconfig used for `paths` resolution: a path (relative to `root`) applied to every file, or
   * `false` to ignore tsconfig files. Default: the nearest tsconfig of each importing file.
   */
  readonly tsconfig?: string | false
  /** Extra **scan** conditions, e.g. `['@znight/source']` to analyse workspace packages from source. */
  readonly conditions?: readonly string[]
  /** Extension of relative imports in the generated module. Default `'js'`. */
  readonly importExtension?: ImportExtension
  /** Emission of provider `source` locations. Default `'dev'` (serve/test only). */
  readonly sourceLocations?: SourceLocationsMode
  /** Strip Znight decorators from the bundle. Default `true`. */
  readonly stripDecorators?: boolean
  /** Additional compiler extensions. */
  readonly extensions?: readonly CompilerExtensionLike[]
  /** Third-party packages allowed to provide compiler extensions through their manifest. */
  readonly trustedExtensions?: readonly string[]
  /** Canonical identities (`'<package>#<Export>'`, `'src/x.ts#Name'`) provided at runtime by custom plugins. */
  readonly externals?: readonly string[]
  /** Packages analysed from source (provider libraries, §6.4). */
  readonly libraries?: readonly string[]
  /** Library mode: emit `dist/znight.providers.json`. Default `false`. */
  readonly library?: boolean
  /** Unvalidated inputs (ZNIGHT017) are errors instead of warnings. Default `false`. */
  readonly strictValidation?: boolean
  /** Report providers unreachable from roots (ZNIGHT019). Default `false`. */
  readonly reportUnused?: boolean
  /** Drop providers unreachable from roots. Default `false`. */
  readonly prune?: boolean
  /** Vite build defaults for a server app, or `false` to leave the Vite config alone. Default `{}`. */
  readonly app?: false | AppOptions
}

/** A string alias (Vite `resolve.alias` entry whose `find` is a string). */
export interface StringAlias {
  readonly find: string
  readonly replacement: string
}

/** Environment-dependent inputs of {@link normalizeOptions} (provided by the Vite plugin / CLI). */
export interface NormalizeOptionsContext {
  /** Base directory for a relative or missing `root`. Default `process.cwd()`. */
  readonly cwd?: string
  /** Runtime conditions (Vite `resolve.conditions`). Default {@link DEFAULT_RUNTIME_CONDITIONS}. */
  readonly runtimeConditions?: readonly string[]
  /** String aliases (Vite `resolve.alias`). RegExp aliases are not supported. */
  readonly aliases?: readonly StringAlias[]
}

/** Fully-defaulted options. Paths are absolute and POSIX-style. */
export interface ResolvedOptions {
  /** Real path of the project root (on-disk casing). */
  readonly root: string
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  /** Absolute path of the generated module. */
  readonly outFile: string
  /** `'auto'` (nearest tsconfig per importing file), an absolute tsconfig path, or `false`. */
  readonly tsconfig: 'auto' | false | string
  /** Conditions used to find sources to analyse: {@link DEFAULT_SCAN_CONDITIONS} + `conditions`. */
  readonly scanConditions: readonly string[]
  /** Conditions used for import routes and loading extensions. */
  readonly runtimeConditions: readonly string[]
  readonly aliases: readonly StringAlias[]
  readonly importExtension: ImportExtension
  readonly sourceLocations: SourceLocationsMode
  readonly stripDecorators: boolean
  readonly extensions: readonly CompilerExtensionLike[]
  readonly trustedExtensions: readonly string[]
  readonly externals: readonly string[]
  readonly libraries: readonly string[]
  readonly library: boolean
  readonly strictValidation: boolean
  readonly reportUnused: boolean
  readonly prune: boolean
  /** `false`, or the app options with an absolute `entry`. */
  readonly app: false | { readonly entry: string }
}

/** Default `include`. */
export const DEFAULT_INCLUDE: readonly string[] = ['src/**/*.{ts,tsx,mts}']
/** Default `exclude`. */
export const DEFAULT_EXCLUDE: readonly string[] = ['**/*.{test,spec}.*', '**/*.d.ts', '**/.znight/**']
/** Default `outFile` (relative to `root`). */
export const DEFAULT_OUT_FILE = 'src/.znight/container.generated.ts'
/** Default server entry for the `app` option (relative to `root`). */
export const DEFAULT_APP_ENTRY = 'src/main.ts'
/** Conditions always used in scan mode (declarations first, then ESM/Node). */
export const DEFAULT_SCAN_CONDITIONS: readonly string[] = ['types', 'import', 'node', 'default']
/** Default runtime conditions (Node.js ESM). */
export const DEFAULT_RUNTIME_CONDITIONS: readonly string[] = ['node', 'import', 'default']
/** Export condition pointing to the TypeScript sources of Znight packages. */
export const SOURCE_CONDITION = '@znight/source'

const IMPORT_EXTENSIONS: readonly ImportExtension[] = ['js', 'ts', 'none']

/**
 * Validates `options` and fills every default.
 *
 * @throws TypeError on invalid values (unknown `importExtension`, non-identity `externals`, empty
 *   globs...). Error messages start with `[znight]` and name the option.
 */
export function normalizeOptions(options: ZnightOptions = {}, context: NormalizeOptionsContext = {}): ResolvedOptions {
  const cwd = resolvePath(context.cwd ?? process.cwd())
  const rootPath = resolvePath(options.root ?? '.', cwd)
  const root = realPath(rootPath) ?? rootPath

  const include = stringList(options.include, 'include') ?? DEFAULT_INCLUDE
  if (include.length === 0) {
    throw new TypeError('[znight] option "include" must contain at least one glob')
  }
  const exclude = stringList(options.exclude, 'exclude') ?? DEFAULT_EXCLUDE

  const outFile = resolvePath(nonEmptyString(options.outFile, 'outFile') ?? DEFAULT_OUT_FILE, root)

  let tsconfig: ResolvedOptions['tsconfig'] = 'auto'
  if (options.tsconfig === false) {
    tsconfig = false
  } else if (options.tsconfig !== undefined) {
    tsconfig = resolvePath(nonEmptyString(options.tsconfig, 'tsconfig') ?? '', root)
  }

  const importExtension = options.importExtension ?? 'js'
  if (!IMPORT_EXTENSIONS.includes(importExtension)) {
    throw new TypeError(
      `[znight] option "importExtension" must be one of 'js', 'ts', 'none' (got ${JSON.stringify(importExtension)})`,
    )
  }
  const sourceLocations = options.sourceLocations ?? 'dev'
  if (sourceLocations !== 'dev' && sourceLocations !== 'always' && sourceLocations !== false) {
    throw new TypeError(
      `[znight] option "sourceLocations" must be 'dev', 'always' or false (got ${JSON.stringify(sourceLocations)})`,
    )
  }

  const externals = stringList(options.externals, 'externals') ?? []
  for (const external of externals) {
    const separator = external.lastIndexOf('#')
    if (separator <= 0 || separator === external.length - 1) {
      throw new TypeError(
        `[znight] option "externals" takes canonical identities such as '@acme/auth#JwtService' or 'src/auth.ts#AuthService', got ${JSON.stringify(external)}`,
      )
    }
  }

  const extensions = options.extensions ?? []
  if (!Array.isArray(extensions)) {
    throw new TypeError('[znight] option "extensions" must be an array of compiler extensions')
  }
  const names = new Set<string>()
  for (const extension of extensions) {
    if (
      typeof extension !== 'object' ||
      extension === null ||
      typeof extension.name !== 'string' ||
      extension.name === ''
    ) {
      throw new TypeError('[znight] option "extensions" must only contain compiler extensions with a non-empty "name"')
    }
    if (names.has(extension.name)) {
      throw new TypeError(
        `[znight] option "extensions" contains two extensions named ${JSON.stringify(extension.name)}`,
      )
    }
    names.add(extension.name)
  }

  let app: ResolvedOptions['app'] = false
  if (options.app !== false) {
    const entry = nonEmptyString(options.app?.entry, 'app.entry') ?? DEFAULT_APP_ENTRY
    app = { entry: resolvePath(entry, root) }
  }

  const aliases = context.aliases ?? []
  for (const alias of aliases) {
    if (typeof alias.find !== 'string' || typeof alias.replacement !== 'string') {
      throw new TypeError('[znight] only string aliases are supported')
    }
  }

  return {
    root,
    include,
    exclude,
    outFile,
    tsconfig,
    scanConditions: unique([...(stringList(options.conditions, 'conditions') ?? []), ...DEFAULT_SCAN_CONDITIONS]),
    runtimeConditions: unique(context.runtimeConditions ?? DEFAULT_RUNTIME_CONDITIONS),
    aliases,
    importExtension,
    sourceLocations,
    stripDecorators: booleanOption(options.stripDecorators, 'stripDecorators', true),
    extensions,
    trustedExtensions: stringList(options.trustedExtensions, 'trustedExtensions') ?? [],
    externals,
    libraries: unique(stringList(options.libraries, 'libraries') ?? []),
    library: booleanOption(options.library, 'library', false),
    strictValidation: booleanOption(options.strictValidation, 'strictValidation', false),
    reportUnused: booleanOption(options.reportUnused, 'reportUnused', false),
    prune: booleanOption(options.prune, 'prune', false),
    app,
  }
}

function stringList(value: readonly string[] | undefined, name: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    throw new TypeError(`[znight] option "${name}" must be an array of non-empty strings`)
  }
  return [...value]
}

function nonEmptyString(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`[znight] option "${name}" must be a non-empty string`)
  }
  return value
}

function booleanOption(value: boolean | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`[znight] option "${name}" must be a boolean`)
  }
  return value
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}
