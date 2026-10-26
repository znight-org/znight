import type { Expression, TSType } from 'oxc-parser'
import type { ZnightOptions } from '../../src/options.ts'
import type { Declaration, SourceFile } from '../../src/project/index.ts'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeOptions } from '../../src/options.ts'
import { Project, realPath, toPosixPath } from '../../src/project/index.ts'

/** Real path of `test/fixtures`. */
export const FIXTURES: string = realPath(fileURLToPath(new URL('../fixtures', import.meta.url))) as string
/** Real path of the main fixture application. */
export const APP: string = `${FIXTURES}/app`

/** A refreshed project on the fixture application. */
export function appProject(options: ZnightOptions = {}): Project {
  const project = new Project(normalizeOptions({ root: APP, ...options }))
  project.refresh()
  return project
}

/** A parsed file of a project, failing loudly when missing. */
export function fileOf(project: Project, relative: string): SourceFile {
  const file = project.getFile(relative)
  if (!file) {
    throw new Error(`missing fixture file ${relative}`)
  }
  return file
}

/** The (first) top-level declaration named `name`. */
export function declarationOf(file: SourceFile, name: string): Declaration {
  const declaration = file.facts.declarations.get(name)?.[0]
  if (!declaration) {
    throw new Error(`no declaration ${name} in ${file.path}`)
  }
  return declaration
}

/** Body of the type alias `name`. */
export function aliasBody(file: SourceFile, name: string): TSType {
  const declaration = declarationOf(file, name)
  if (declaration.node.type !== 'TSTypeAliasDeclaration') {
    throw new Error(`${name} is not a type alias`)
  }
  return declaration.node.typeAnnotation
}

/** Initializer of the variable `name`. */
export function initializerOf(file: SourceFile, name: string): Expression {
  const declaration = declarationOf(file, name)
  if (declaration.node.type !== 'VariableDeclarator' || !declaration.node.init) {
    throw new Error(`${name} has no initializer`)
  }
  return declaration.node.init
}

/** A temporary directory (real path) populated with `files`; call `cleanup()` when done. */
export interface TempDir {
  readonly root: string
  write(relative: string, content: string): string
  remove(relative: string): void
  cleanup(): void
}

export function tempDir(files: Record<string, string> = {}): TempDir {
  const root = toPosixPath(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-project-'))))
  const dir: TempDir = {
    root,
    write(relative, content) {
      const file = `${root}/${relative}`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return file
    },
    remove(relative) {
      fs.rmSync(`${root}/${relative}`, { force: true, recursive: true })
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
  for (const [relative, content] of Object.entries(files)) {
    dir.write(relative, content)
  }
  return dir
}

/** `true` when the file system of the fixtures is case-insensitive (macOS, Windows defaults). */
export function caseInsensitiveFileSystem(): boolean {
  return fs.existsSync(`${APP}/PACKAGE.JSON`)
}
