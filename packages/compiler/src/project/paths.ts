/**
 * Path helpers shared by the project model.
 *
 * Every absolute path handled by the project layer is **POSIX-style** (forward slashes, also on
 * Windows: `C:/repo/src/a.ts`) and, for files that exist, the **real path with the on-disk casing**
 * (`fs.realpathSync.native`). Keeping a single representation makes paths usable as map keys and
 * makes identities independent of symlinks and of the casing used in import specifiers.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Converts native separators to forward slashes. */
export function toPosixPath(value: string): string {
  return value.includes('\\') ? value.replaceAll('\\', '/') : value
}

/** Resolves `value` against `base` (default: cwd) and returns a normalized POSIX absolute path. */
export function resolvePath(value: string, base?: string): string {
  return toPosixPath(base === undefined ? path.resolve(value) : path.resolve(base, value))
}

/**
 * Real path of an existing file or directory, with symlinks resolved and the exact on-disk casing
 * (`realpathSync.native` canonicalizes casing on case-insensitive file systems). Returns
 * `undefined` when the path does not exist.
 */
export function realPath(value: string): string | undefined {
  try {
    return toPosixPath(fs.realpathSync.native(value))
  } catch {
    return undefined
  }
}

/** POSIX relative path from directory `from` to `to` (both absolute). */
export function relativePath(from: string, to: string): string {
  return path.posix.relative(toPosixPath(from), toPosixPath(to))
}

/** POSIX directory name. */
export function dirName(value: string): string {
  return path.posix.dirname(toPosixPath(value))
}

/** `true` when `file` is `dir` itself or is located inside `dir` (both absolute POSIX paths). */
export function isWithin(dir: string, file: string): boolean {
  if (file === dir) {
    return true
  }
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  return file.startsWith(prefix)
}

/** `true` for `./x`, `../x`, `.`, `..` and absolute paths. */
export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  )
}

/** `true` for a bare (package) specifier such as `pg`, `@scope/pkg/sub` or `node:fs`. */
export function isBareSpecifier(specifier: string): boolean {
  return !isRelativeSpecifier(specifier) && !specifier.startsWith('#')
}

/** Package name of a bare specifier: `@scope/pkg/sub/path` → `@scope/pkg`, `pg/lib` → `pg`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
  }
  return parts[0] ?? specifier
}

/**
 * Public name of a package: DefinitelyTyped packages are mapped to the package they type
 * (`@types/pg` → `pg`, `@types/babel__core` → `@babel/core`), every other name is unchanged.
 */
export function publicPackageName(name: string): string {
  if (!name.startsWith('@types/')) {
    return name
  }
  const typed = name.slice('@types/'.length)
  const scoped = typed.indexOf('__')
  return scoped > 0 ? `@${typed.slice(0, scoped)}/${typed.slice(scoped + 2)}` : typed
}

const DECLARATION_FILE = /\.d\.(?:[^./\\]+\.)?[cm]?ts$/

/** `true` for TypeScript declaration files (`.d.ts`, `.d.mts`, `.d.cts`, `.d.css.ts`...). */
export function isDeclarationPath(file: string): boolean {
  return DECLARATION_FILE.test(file)
}

/** Extensions of files the project layer can parse. */
export const PARSEABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/** `true` when the file extension is one the parser understands. */
export function isParseablePath(file: string): boolean {
  return PARSEABLE_EXTENSIONS.includes(path.posix.extname(file))
}

/** `true` for TypeScript sources (not declaration files): `.ts`, `.tsx`, `.mts`, `.cts`. */
export function isTypeScriptSourcePath(file: string): boolean {
  const extension = path.posix.extname(file)
  return (
    (extension === '.ts' || extension === '.tsx' || extension === '.mts' || extension === '.cts') &&
    !isDeclarationPath(file)
  )
}

/** `true` for JavaScript files (`.js`, `.jsx`, `.mjs`, `.cjs`). */
export function isJavaScriptPath(file: string): boolean {
  const extension = path.posix.extname(file)
  return extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs'
}

/** Base names of files whose change invalidates module resolution (§4.3). */
const RESOLUTION_CONFIG_FILE =
  /^(?:package\.json|tsconfig.*\.json|jsconfig.*\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/

/** `true` for `package.json`, `tsconfig*.json` and lockfiles. */
export function isResolutionConfigPath(file: string): boolean {
  return RESOLUTION_CONFIG_FILE.test(path.posix.basename(toPosixPath(file)))
}
