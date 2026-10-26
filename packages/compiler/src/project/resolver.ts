/**
 * Module resolution (§4.3): a thin wrapper over oxc-resolver with two condition sets.
 *
 * - **scan** mode finds the files to analyse: TypeScript sources first (`.js` → `.ts`), declaration
 *   files (`types` condition and field, `.d.ts`/`.d.mts`), and the scan conditions (which may include
 *   `@znight/source`). When a bare specifier resolves to JavaScript, the TypeScript declaration
 *   lookup (`@types/*`, sibling `.d.ts`) is tried as a fallback.
 * - **runtime** mode answers "what does Node/Vite load for this specifier" and is used to validate
 *   import routes and to load compiler extensions.
 *
 * tsconfig `paths` come from the nearest tsconfig of the importing file (`tsconfig: 'auto'`), from
 * a fixed tsconfig file, or are disabled (`false`).
 */

import type { NapiResolveOptions, ResolveResult } from 'oxc-resolver'
import type { StringAlias } from '../options.ts'

import { ResolverFactory } from 'oxc-resolver'

import { dirName, isBareSpecifier, isJavaScriptPath, realPath, toPosixPath } from './paths.ts'

/** Which condition set to resolve with. */
export type ResolutionMode = 'scan' | 'runtime'

/** A specifier resolved to a file. */
export interface ResolvedFile {
  readonly kind: 'file'
  /** Absolute POSIX real path with the on-disk casing. */
  readonly path: string
  /** Path as produced by the resolver (casing of the specifier, before `realpath`). */
  readonly requestedPath: string
  /**
   * The specifier's casing differs from the file on disk (only possible on case-insensitive file
   * systems; the import would fail on Linux). Reported as a ZNIGHT010 warning.
   */
  readonly casingMismatch: boolean
}

/** A Node.js builtin module. */
export interface ResolvedBuiltin {
  readonly kind: 'builtin'
  /** Normalized specifier, always `node:`-prefixed (`fs` → `node:fs`). */
  readonly specifier: string
}

/** The specifier could not be resolved. */
export interface UnresolvedModule {
  readonly kind: 'not-found'
  readonly message: string
}

/** Result of {@link ModuleResolver.resolve}. */
export type ModuleResolution = ResolvedFile | ResolvedBuiltin | UnresolvedModule

/** Configuration of a {@link ModuleResolver}. */
export interface ModuleResolverOptions {
  /** `'auto'`: nearest tsconfig of each importing file; a path: that tsconfig; `false`: none. */
  readonly tsconfig: 'auto' | false | string
  readonly scanConditions: readonly string[]
  readonly runtimeConditions: readonly string[]
  /** String aliases (Vite `resolve.alias` entries with a string `find`). */
  readonly aliases: readonly StringAlias[]
}

const SCAN_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
]
const RUNTIME_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.node']

/** oxc-resolver wrapper with a scan and a runtime condition set sharing one cache. */
export class ModuleResolver {
  readonly options: ModuleResolverOptions
  readonly #scan: ResolverFactory
  readonly #runtime: ResolverFactory
  readonly #memo = new Map<string, ModuleResolution>()

  constructor(options: ModuleResolverOptions) {
    this.options = options
    const alias: Record<string, string[]> = {}
    for (const entry of options.aliases) {
      alias[entry.find] = [entry.replacement]
    }
    const common: NapiResolveOptions = {
      ...tsconfigOption(options.tsconfig),
      alias,
      builtinModules: true,
      symlinks: true,
      nodePath: false,
    }
    this.#scan = new ResolverFactory({
      ...common,
      conditionNames: [...options.scanConditions],
      extensions: SCAN_EXTENSIONS,
      extensionAlias: {
        '.js': ['.ts', '.tsx', '.d.ts', '.js', '.jsx'],
        '.jsx': ['.tsx', '.jsx'],
        '.mjs': ['.mts', '.d.mts', '.mjs'],
        '.cjs': ['.cts', '.d.cts', '.cjs'],
      },
      mainFields: ['types', 'typings', 'module', 'main'],
    })
    this.#runtime = this.#scan.cloneWithOptions({
      ...common,
      conditionNames: [...options.runtimeConditions],
      extensions: RUNTIME_EXTENSIONS,
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs'], '.cjs': ['.cts', '.cjs'] },
      mainFields: ['module', 'main'],
    })
  }

  /**
   * Resolves `specifier` as imported by `fromFile` (absolute path). Results are memoized until
   * {@link clearCache}.
   */
  resolve(fromFile: string, specifier: string, mode: ResolutionMode = 'scan'): ModuleResolution {
    const key = `${mode}\0${fromFile}\0${specifier}`
    const cached = this.#memo.get(key)
    if (cached) {
      return cached
    }
    const factory = mode === 'scan' ? this.#scan : this.#runtime
    const result =
      this.options.tsconfig === 'auto'
        ? factory.resolveFileSync(fromFile, specifier)
        : factory.sync(dirName(fromFile), specifier)
    const resolution = toResolution(this.#withDeclarations(factory, mode, fromFile, specifier, result))
    this.#memo.set(key, resolution)
    return resolution
  }

  /**
   * Resolves `specifier` from a directory (no tsconfig lookup). Used for package self-references
   * (`@acme/lib` from the package's own directory) when computing public entries.
   */
  resolveFromDirectory(directory: string, specifier: string, mode: ResolutionMode = 'scan'): ModuleResolution {
    const key = `${mode}:dir\0${directory}\0${specifier}`
    const cached = this.#memo.get(key)
    if (cached) {
      return cached
    }
    const factory = mode === 'scan' ? this.#scan : this.#runtime
    const result = factory.sync(directory, specifier)
    const resolution = toResolution(this.#withDeclarations(factory, mode, `${directory}/index.ts`, specifier, result))
    this.#memo.set(key, resolution)
    return resolution
  }

  /**
   * In scan mode, a bare specifier resolving to JavaScript is looked up again with the TypeScript
   * declaration algorithm (`types` next to the file, `@types/*`).
   */
  #withDeclarations(
    factory: ResolverFactory,
    mode: ResolutionMode,
    fromFile: string,
    specifier: string,
    result: ResolveResult,
  ): ResolveResult {
    if (mode !== 'scan' || result.path === undefined || !isJavaScriptPath(result.path) || !isBareSpecifier(specifier)) {
      return result
    }
    const declarations = factory.resolveDtsSync(fromFile, specifier)
    return declarations.path !== undefined && !isJavaScriptPath(declarations.path) ? declarations : result
  }

  /** Clears the oxc-resolver cache and the memo (call on file create/unlink and config changes). */
  clearCache(): void {
    this.#memo.clear()
    this.#scan.clearCache()
    this.#runtime.clearCache()
  }
}

function tsconfigOption(tsconfig: ModuleResolverOptions['tsconfig']): Pick<NapiResolveOptions, 'tsconfig'> {
  if (tsconfig === false) {
    return {}
  }
  return { tsconfig: tsconfig === 'auto' ? 'auto' : { configFile: tsconfig, references: 'auto' } }
}

function toResolution(result: ResolveResult): ModuleResolution {
  if (result.builtin) {
    return { kind: 'builtin', specifier: result.builtin.resolved }
  }
  if (result.path === undefined) {
    return { kind: 'not-found', message: result.error ?? 'Cannot resolve module' }
  }
  const requestedPath = toPosixPath(result.path)
  const path = realPath(result.path) ?? requestedPath
  const casingMismatch = path !== requestedPath && path.toLowerCase() === requestedPath.toLowerCase()
  return { kind: 'file', path, requestedPath, casingMismatch }
}
