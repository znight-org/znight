/**
 * The error module: what the generated module becomes in watch/serve modes when the compilation
 * fails. It still exports a typed `__ZNIGHT_METADATA__` (importers keep type-checking and linking),
 * but importing it throws a `ZnightError` carrying the formatted diagnostics.
 */
import type { Diagnostic } from '../project/index.ts'

import { ErrorCode } from '@znight/core'

import { formatDiagnostics } from '../diagnostics/format.ts'
import { COMPILER_VERSION } from '../version.ts'
import { generatedHeader, METADATA_EXPORT } from './container.ts'
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
    "import type { ZnightMetadata } from '@znight/core'",
    "import { ZnightError } from '@znight/core'",
    '',
    'function fail(): never {',
    `  throw new ZnightError(${quote(code)}, ${quote(message)})`,
    '}',
    '',
    `export const ${METADATA_EXPORT}: ZnightMetadata = fail()`,
    `export default ${METADATA_EXPORT}`,
    '',
  ].join('\n')
}
