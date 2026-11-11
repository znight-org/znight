/**
 * The error module: what the generated module becomes in watch/serve modes when the compilation
 * fails. It still exports a typed `metadata`, `createApplication` and the deprecated alias (importers
 * keep type-checking and linking), but importing it throws a `ZnightError` carrying the formatted
 * diagnostics.
 */
import type { Diagnostic } from '../project/index.ts'

import { ErrorCode } from '@znight/core'

import { formatDiagnostics } from '../diagnostics/format.ts'
import { COMPILER_VERSION } from '../version.ts'
import {
  CREATE_APPLICATION_EXPORT,
  EXPORT_DOCS,
  generatedHeader,
  LEGACY_METADATA_EXPORT,
  METADATA_EXPORT,
} from './container.ts'
import { quote } from './syntax.ts'

/** Options of {@link renderErrorModule}. */
export interface RenderErrorModuleOptions {
  /** Paths in the message are relative to this directory. Default `process.cwd()`. */
  readonly cwd?: string
  /** Source text of a file for code frames (default: read from disk). */
  readonly readFile?: (file: string) => string | undefined
  /** Compiler version written in the header. Default: this compiler's version. */
  readonly version?: string
}

/** A generated module that throws a `ZnightError` with the formatted diagnostics when imported. */
export function renderErrorModule(diagnostics: readonly Diagnostic[], options: RenderErrorModuleOptions = {}): string {
  const first = diagnostics.find(diagnostic => diagnostic.severity === 'error') ?? diagnostics[0]
  const code = first?.code ?? ErrorCode.VersionMismatch
  const formatted = formatDiagnostics(diagnostics, {
    color: false,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  })
  const message = `The Znight compilation failed, the generated container is unusable.\n\n${formatted || 'Unknown error'}`
  return [
    ...generatedHeader(options.version ?? COMPILER_VERSION),
    "import type { CreateApplicationOptions, ZnightMetadata } from '@znight/core'",
    "import { Application, ZnightError } from '@znight/core'",
    '',
    'function fail(): never {',
    `  throw new ZnightError(${quote(code)}, ${quote(message)})`,
    '}',
    '',
    EXPORT_DOCS.metadata,
    `export const ${METADATA_EXPORT}: ZnightMetadata = fail()`,
    '',
    EXPORT_DOCS.createApplication,
    `export function ${CREATE_APPLICATION_EXPORT}(options: CreateApplicationOptions = {}): Promise<Application> {`,
    `  return Application.create({ ...options, ${METADATA_EXPORT} })`,
    '}',
    '',
    EXPORT_DOCS.legacy,
    `export const ${LEGACY_METADATA_EXPORT}: ZnightMetadata = ${METADATA_EXPORT}`,
    `export default ${METADATA_EXPORT}`,
    '',
  ].join('\n')
}
