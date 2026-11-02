/**
 * Extra outputs (`GenerateContext.emitFile`, §6.5): files that compiler extensions write next to the
 * generated module (an SDL schema, a JSON document...). Paths are relative to the project root and
 * validated here; the files are written by `generate()`, the Vite plugin and the Bun preload with
 * the generated module (only when the compile is ok and the content changed).
 */
import type { Diagnostic, Project } from '../project/index.ts'

import path from 'node:path'
import { ErrorCode } from '@znight/core'

import { PROVIDERS_FILE } from '../library/schema.ts'
import { compareStrings } from '../project/compare.ts'
import { isParseablePath, isWithin, resolvePath, toPosixPath } from '../project/paths.ts'

/** A file emitted by a compiler extension (`CompileResult.extraFiles`). */
export interface ExtraFile {
  /** Absolute POSIX path (inside the project root). */
  readonly file: string
  readonly content: string
  /** Name of the extension that emitted it. */
  readonly extension: string
}

/** The extra files of one rendering of the generated module. */
export class ExtraFiles {
  readonly #project: Project
  readonly #report: (diagnostic: Diagnostic) => void
  readonly #files = new Map<string, ExtraFile>()

  constructor(project: Project, report: (diagnostic: Diagnostic) => void) {
    this.#project = project
    this.#report = report
  }

  /** `emitFile(relativePath, content)` of `extension`: a ZNIGHT018 error when the path is refused. */
  emit(extension: string, relativePath: unknown, content: unknown): void {
    if (typeof relativePath !== 'string') {
      throw new TypeError(`[znight] emitFile() takes a path relative to the project root (got ${typeof relativePath})`)
    }
    if (typeof content !== 'string') {
      throw new TypeError(`[znight] emitFile('${relativePath}') takes a string content (got ${typeof content})`)
    }
    const resolved = this.#resolve(relativePath)
    if (typeof resolved !== 'string') {
      this.#refuse(extension, relativePath, resolved.problem)
      return
    }
    const previous = this.#files.get(resolved)
    if (previous !== undefined) {
      this.#refuse(
        extension,
        relativePath,
        previous.extension === extension
          ? 'the extension already emitted this file'
          : `extension '${previous.extension}' already emitted this file`,
      )
      return
    }
    this.#files.set(resolved, Object.freeze({ file: resolved, content, extension }))
  }

  /** The emitted files, sorted by path. */
  list(): ExtraFile[] {
    return [...this.#files.values()].sort((a, b) => compareStrings(a.file, b.file))
  }

  /** Absolute path of a valid relative path, or why it is refused. */
  #resolve(relativePath: string): string | { readonly problem: string } {
    const root = this.#project.root
    const posix = toPosixPath(relativePath)
    if (posix === '' || posix.endsWith('/')) {
      return { problem: 'the path must name a file' }
    }
    if (path.posix.isAbsolute(posix) || path.win32.isAbsolute(relativePath)) {
      return { problem: 'the path must be relative to the project root' }
    }
    const file = resolvePath(posix, root)
    if (file === root || !isWithin(root, file)) {
      return { problem: 'the path must stay inside the project root' }
    }
    const segments = path.posix.relative(root, file).split('/')
    if (segments.includes('node_modules')) {
      return { problem: 'the path cannot be inside node_modules' }
    }
    if (file === this.#project.options.outFile) {
      return { problem: 'it is the generated module (outFile)' }
    }
    if (file === `${root}/dist/${PROVIDERS_FILE}`) {
      return { problem: 'it is the compiled provider library manifest' }
    }
    // dot-files and dot-directories are never scanned (`.znight/`)
    if (isParseablePath(file) && !segments.some(segment => segment.startsWith('.'))) {
      return {
        problem: 'a source file would be scanned by the compiler: write it under a dot-directory (src/.znight/)',
      }
    }
    return file
  }

  #refuse(extension: string, relativePath: string, problem: string): void {
    this.#report({
      code: ErrorCode.VersionMismatch,
      severity: 'error',
      message: `Compiler extension '${extension}' cannot emit the file ${JSON.stringify(relativePath)}: ${problem}`,
      hints: [
        'Extra files (GenerateContext.emitFile) are relative to the project root, outside node_modules, and are not sources of the compiler',
        'Check the option of the extension that names this file',
      ],
    })
  }
}
