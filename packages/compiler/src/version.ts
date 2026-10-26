/**
 * Version of `@znight/compiler` and the version-skew check of the `@znight/*` packages (ZNIGHT018).
 *
 * All `@znight/*` packages are released in lockstep. The generated module and the compiler
 * extensions are only guaranteed to work with the runtime packages of the same release line: in
 * `0.x` the minor version must match the compiler's, from `1.0` the major version.
 */
import type { Diagnostic, Location, PackageInfo, Project } from './project/index.ts'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ErrorCode } from '@znight/core'

import { compareStrings } from './project/compare.ts'
import { LineIndex } from './project/index.ts'

const PACKAGE_NAME = '@znight/compiler'

/** Version of this `@znight/compiler` (read from its package.json; `0.0.0` when not found). */
export const COMPILER_VERSION: string = readOwnVersion()

function readOwnVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (json.name === PACKAGE_NAME && typeof json.version === 'string') {
        return json.version
      }
    } catch {
      // no package.json here
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return '0.0.0'
    }
    dir = parent
  }
}

/** `major.minor.patch` of a semver string (prerelease and build metadata ignored). */
export function parseVersion(
  version: string,
): { readonly major: number; readonly minor: number; readonly patch: number } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) {
    return undefined
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** `true` when two versions belong to the same release line (same minor in 0.x, same major otherwise). */
export function compatibleVersions(a: string, b: string): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) {
    return true
  }
  if (left.major !== right.major) {
    return false
  }
  return left.major !== 0 || left.minor === right.minor
}

/**
 * ZNIGHT018 for every installed `@znight/*` package (`@znight/core` and the `@znight/*` dependencies
 * of the root package, resolved from the root) whose version is not compatible with the compiler.
 */
export function checkVersionSkew(project: Project, compilerVersion: string = COMPILER_VERSION): Diagnostic[] {
  const names = new Set<string>(['@znight/core'])
  const root = project.rootPackage
  if (root) {
    for (const name of project.packages.dependencyNames(root)) {
      if (name.startsWith('@znight/')) {
        names.add(name)
      }
    }
  }
  const diagnostics: Diagnostic[] = []
  for (const name of [...names].sort(compareStrings)) {
    const info = project.packages.findInstalled(name, project.root)
    if (!info || info.version === undefined || (root !== undefined && info.dir === root.dir)) {
      continue
    }
    if (compatibleVersions(info.version, compilerVersion)) {
      continue
    }
    const expected = releaseLine(compilerVersion)
    const location = root ? dependencyLocation(root, name) : undefined
    diagnostics.push({
      code: ErrorCode.VersionMismatch,
      severity: 'error',
      message: `${name}@${info.version} is not compatible with @znight/compiler@${compilerVersion}`,
      ...(location ? { location } : {}),
      hints: [
        `All @znight/* packages are released together: install ${name}@${expected} (the same release line as @znight/compiler)`,
      ],
    })
  }
  return diagnostics
}

/** `0.1.x` / `2.x`: the versions compatible with `version`. */
function releaseLine(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) {
    return version
  }
  return parsed.major === 0 ? `0.${parsed.minor}.x` : `${parsed.major}.x`
}

/** Location of `"<name>"` in the root package.json (dependency key). */
function dependencyLocation(root: PackageInfo, name: string): Location | undefined {
  const needle = `"${name}"`
  const start = root.text.indexOf(needle)
  if (start === -1) {
    return undefined
  }
  const lines = new LineIndex(root.text)
  const from = lines.positionAt(start)
  const to = lines.positionAt(start + needle.length)
  return {
    file: root.packageJsonPath,
    line: from.line,
    column: from.column,
    endLine: to.line,
    endColumn: to.column,
    start,
    end: start + needle.length,
  }
}
