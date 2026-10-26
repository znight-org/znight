/**
 * Reading and validation of `package.json#znight` manifests (§7).
 *
 * Every problem is reported as a ZNIGHT018 diagnostic located in the package.json: an unsupported
 * `apiVersion` is an error (the manifest is ignored), a missing `apiVersion` is a warning (version 1
 * is assumed), malformed entries are errors and are skipped.
 */

import type { Scope } from '@znight/core'
import type { Diagnostic } from './diagnostics.ts'
import type { Location } from './location.ts'
import type { PackageInfo } from './packages.ts'

import { ErrorCode } from '@znight/core'

import { LineIndex } from './location.ts'
import { resolvePath } from './paths.ts'

/** Manifest API version understood by this compiler. */
export const MANIFEST_API_VERSION = 1

/** A type provided at runtime by a plugin (`provides` entry). */
export interface ProvidedExternal {
  /** Export name in the package's public entry. */
  readonly export: string
  /** Canonical identity / token: `<package>#<export>`. */
  readonly identity: string
  /** Plugin expected to register it (used in error messages). */
  readonly plugin: string | undefined
  readonly scope: Scope
  readonly optional: boolean
}

/** An interceptor decorator declared by the package (`interceptors` entry). */
export interface InterceptorDeclaration {
  /** Export name of the decorator, and its identity. */
  readonly decorator: string
  readonly decoratorIdentity: string
  /** Export name of the interceptor provider class, and its identity. */
  readonly interceptor: string
  readonly interceptorIdentity: string
}

/** A validated `package.json#znight` manifest. */
export interface PackageManifest {
  readonly packageName: string
  readonly packageDir: string
  readonly apiVersion: number
  /** Modules exporting compiler extensions (bare specifiers), in declaration order. */
  readonly compiler: readonly string[]
  readonly provides: readonly ProvidedExternal[]
  readonly interceptors: readonly InterceptorDeclaration[]
  /** `'source'` for provider libraries analysed from source (§6.4). */
  readonly library: 'source' | undefined
  /** Absolute path of the compiled providers file (`znight.providers.json`). */
  readonly providers: string | undefined
}

/** Result of {@link readManifest}. */
export interface ManifestResult {
  /** `undefined` when the package has no manifest or when it is unusable. */
  readonly manifest: PackageManifest | undefined
  readonly diagnostics: readonly Diagnostic[]
}

const SCOPES: readonly string[] = ['singleton', 'request', 'transient']
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Reads and validates the `znight` field of a package.json. */
export function readManifest(info: PackageInfo): ManifestResult {
  const raw = info.json.znight
  if (raw === undefined) {
    return { manifest: undefined, diagnostics: [] }
  }
  const diagnostics: Diagnostic[] = []
  const location = manifestLocation(info)
  const packageName = info.publicName ?? info.name ?? info.dir
  const report = (severity: 'error' | 'warning', message: string, hints?: string[]): void => {
    diagnostics.push({
      code: ErrorCode.VersionMismatch,
      severity,
      message: `${packageName}: ${message}`,
      location,
      ...(hints ? { hints } : {}),
    })
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    report('error', 'package.json "znight" must be an object')
    return { manifest: undefined, diagnostics }
  }
  if (info.publicName === undefined) {
    report('error', 'a package with a "znight" manifest must have a "name"')
    return { manifest: undefined, diagnostics }
  }
  const field = raw as Record<string, unknown>

  let apiVersion = MANIFEST_API_VERSION
  const declaredVersion = field.apiVersion
  if (declaredVersion === undefined) {
    report('warning', `manifest has no "apiVersion", assuming ${MANIFEST_API_VERSION}`, [
      `Add "apiVersion": ${MANIFEST_API_VERSION} to the "znight" field`,
    ])
  } else if (typeof declaredVersion !== 'number' || !Number.isInteger(declaredVersion)) {
    report('error', `manifest "apiVersion" must be an integer (got ${JSON.stringify(declaredVersion)})`)
    return { manifest: undefined, diagnostics }
  } else if (declaredVersion === MANIFEST_API_VERSION) {
    apiVersion = declaredVersion
  } else {
    report(
      'error',
      `manifest apiVersion ${declaredVersion} is not supported by this compiler (supported: ${MANIFEST_API_VERSION})`,
      [
        declaredVersion > MANIFEST_API_VERSION
          ? 'Upgrade @znight/compiler to a version supporting this package'
          : `Upgrade ${packageName} to a version built for this compiler`,
      ],
    )
    return { manifest: undefined, diagnostics }
  }

  const compiler: string[] = []
  const compilerField = field.compiler
  if (compilerField !== undefined) {
    const list = Array.isArray(compilerField) ? compilerField : [compilerField]
    for (const item of list) {
      if (typeof item === 'string' && item !== '') {
        compiler.push(item)
      } else {
        report(
          'error',
          `manifest "compiler" must be a module specifier or an array of specifiers (got ${JSON.stringify(item)})`,
        )
      }
    }
  }

  const provides: ProvidedExternal[] = []
  for (const [index, entry] of arrayField(field, 'provides', report)) {
    const exportName = entry.export
    if (typeof exportName !== 'string' || !IDENTIFIER.test(exportName)) {
      report('error', `manifest "provides[${index}].export" must be an export name (got ${JSON.stringify(exportName)})`)
      continue
    }
    const plugin = entry.plugin
    if (plugin !== undefined && typeof plugin !== 'string') {
      report('error', `manifest "provides[${index}].plugin" must be a string`)
      continue
    }
    const scope = entry.scope ?? 'singleton'
    if (typeof scope !== 'string' || !SCOPES.includes(scope)) {
      report(
        'error',
        `manifest "provides[${index}].scope" must be 'singleton', 'request' or 'transient' (got ${JSON.stringify(scope)})`,
      )
      continue
    }
    const optional = entry.optional ?? false
    if (typeof optional !== 'boolean') {
      report('error', `manifest "provides[${index}].optional" must be a boolean`)
      continue
    }
    provides.push({
      export: exportName,
      identity: `${info.publicName}#${exportName}`,
      plugin,
      scope: scope as Scope,
      optional,
    })
  }

  const interceptors: InterceptorDeclaration[] = []
  for (const [index, entry] of arrayField(field, 'interceptors', report)) {
    const decorator = entry.decorator
    const interceptor = entry.interceptor
    if (typeof decorator !== 'string' || !IDENTIFIER.test(decorator)) {
      report(
        'error',
        `manifest "interceptors[${index}].decorator" must be an export name (got ${JSON.stringify(decorator)})`,
      )
      continue
    }
    if (typeof interceptor !== 'string' || !IDENTIFIER.test(interceptor)) {
      report(
        'error',
        `manifest "interceptors[${index}].interceptor" must be an export name (got ${JSON.stringify(interceptor)})`,
      )
      continue
    }
    interceptors.push({
      decorator,
      decoratorIdentity: `${info.publicName}#${decorator}`,
      interceptor,
      interceptorIdentity: `${info.publicName}#${interceptor}`,
    })
  }

  let library: 'source' | undefined
  const libraryField = field.library
  if (libraryField === 'source') {
    library = 'source'
  } else if (libraryField !== undefined) {
    report('error', `manifest "library" must be 'source' (got ${JSON.stringify(libraryField)})`)
  }

  let providers: string | undefined
  const providersField = field.providers
  if (typeof providersField === 'string' && providersField !== '') {
    providers = resolvePath(providersField, info.dir)
  } else if (providersField !== undefined) {
    report('error', `manifest "providers" must be a path to a znight.providers.json file`)
  }

  return {
    manifest: {
      packageName: info.publicName,
      packageDir: info.dir,
      apiVersion,
      compiler,
      provides,
      interceptors,
      library,
      providers,
    },
    diagnostics,
  }
}

/** Object entries of an array field, in order; other entries are reported as they are reached. */
function* arrayField(
  field: Record<string, unknown>,
  name: string,
  report: (severity: 'error', message: string) => void,
): Generator<[number, Record<string, unknown>]> {
  const value = field[name]
  if (value === undefined) {
    return
  }
  if (!Array.isArray(value)) {
    report('error', `manifest "${name}" must be an array`)
    return
  }
  for (const [index, entry] of (value as unknown[]).entries()) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      yield [index, entry as Record<string, unknown>]
    } else {
      report('error', `manifest "${name}[${index}]" must be an object`)
    }
  }
}

/** Location of the `"znight"` key in package.json (start of the file when not found). */
function manifestLocation(info: PackageInfo): Location {
  const found = info.text.indexOf('"znight"')
  const offset = Math.max(found, 0)
  const end = found === -1 ? 0 : found + '"znight"'.length
  const lines = new LineIndex(info.text)
  const start = lines.positionAt(offset)
  const finish = lines.positionAt(end)
  return {
    file: info.packageJsonPath,
    line: start.line,
    column: start.column,
    endLine: finish.line,
    endColumn: finish.column,
    start: offset,
    end,
  }
}
