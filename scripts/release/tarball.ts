/**
 * Packing (`bun pm pack`) and verification of the publishable tarballs.
 *
 * `bun pm pack` rewrites the `workspace:` and `catalog:` dependency ranges to real versions; the
 * verification makes sure it did, and that the tarball is complete (dist, README, LICENSE, every
 * entry point referenced by `exports`/`types`/`bin`) before anything is published.
 */
import type { Manifest, WorkspacePackage } from './workspace.ts'

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { formatBytes, log, runOrThrow, summary } from './support.ts'
import { DEPENDENCY_FIELDS, lockstepVersion, REPOSITORY, ROOT } from './workspace.ts'

export interface Finding {
  readonly level: 'error' | 'warning'
  readonly message: string
}

export interface TarballContents {
  /** File paths inside the tarball (`package/...`). */
  readonly files: ReadonlySet<string>
  /** The packed `package.json`, as written in the tarball. */
  readonly rawManifest: string
  readonly manifest: Manifest
}

export interface PackedPackage {
  readonly pkg: WorkspacePackage
  /** Absolute path of the tarball. */
  readonly tarball: string
  readonly size: number
  readonly fileCount: number
  readonly findings: readonly Finding[]
}

export interface VerifyOptions {
  /** The lockstep version: internal dependency ranges must accept it. */
  readonly version: string
  /** Names of the packages released together. */
  readonly internal: ReadonlySet<string>
  /**
   * How a missing README is reported: an error when releasing, a warning in pull requests (packages
   * in progress may not have one yet).
   */
  readonly missingReadme: 'error' | 'warning'
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i
const README_ENTRY = /^package\/readme(\.(md|markdown|txt))?$/i
const LICENSE_ENTRY = /^package\/(licen[cs]e|copying)(\.(md|txt))?$/i
const FORBIDDEN_ENTRY = /(^|\/)(node_modules|\.znight)\/|\.tsbuildinfo$|(^|\/)\.env(\.[^/]*)?$|(^|\/)\.npmrc$/
const TEST_ENTRY = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/

/** File name `bun pm pack` gives the tarball of a package (`@znight/core@0.1.0` → `znight-core-0.1.0.tgz`). */
export function tarballName(pkg: Pick<WorkspacePackage, 'name' | 'version'>): string {
  return `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`
}

/**
 * Packs a package with `bun pm pack` into `outDir`. Packages without a LICENSE file get the
 * repository LICENSE for the duration of the pack (npm always includes LICENSE files).
 */
export async function packPackage(pkg: WorkspacePackage, outDir: string): Promise<string> {
  const injectLicense = !readdirSync(pkg.dir).some(file => LICENSE_FILE.test(file))
  const licensePath = join(pkg.dir, 'LICENSE')
  if (injectLicense) copyFileSync(join(ROOT, 'LICENSE'), licensePath)
  try {
    await runOrThrow(process.execPath, ['pm', 'pack', '--destination', outDir, '--quiet'], { cwd: pkg.dir })
  } finally {
    if (injectLicense) rmSync(licensePath, { force: true })
  }
  const tarball = join(outDir, tarballName(pkg))
  if (!existsSync(tarball)) throw new Error(`bun pm pack did not write ${tarball}`)
  return tarball
}

/** Lists the files of a tarball and reads its `package.json`. */
export async function inspectTarball(tarball: string): Promise<TarballContents> {
  const listing = await runOrThrow('tar', ['-tzf', tarball])
  const files = new Set(
    listing.stdout
      .split('\n')
      .map(line => line.trim().replace(/^\.\//, ''))
      .filter(line => line !== '' && !line.endsWith('/')),
  )
  const rawManifest = await readTarballEntry(tarball, 'package/package.json')
  return { files, rawManifest, manifest: JSON.parse(rawManifest) as Manifest }
}

/** Reads one file of a tarball. */
export async function readTarballEntry(tarball: string, path: string): Promise<string> {
  return (await runOrThrow('tar', ['-xzf', tarball, '-O', path])).stdout
}

/** Every string target of an `exports` map (conditions and subpaths included). */
function exportTargets(value: unknown, targets: Set<string>): void {
  if (typeof value === 'string') targets.add(value)
  else if (Array.isArray(value)) for (const item of value) exportTargets(item, targets)
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) exportTargets(item, targets)
}

function binTargets(bin: Manifest['bin']): string[] {
  if (bin === undefined) return []
  return typeof bin === 'string' ? [bin] : Object.values(bin)
}

const toEntry = (target: string): string => `package/${target.replace(/^\.\//, '')}`

function repositoryUrl(manifest: Manifest): string | undefined {
  return typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
}

/** Checks a packed tarball. Returns the problems found (errors block the release). */
export async function verifyTarball(
  pkg: WorkspacePackage,
  tarball: string,
  contents: TarballContents,
  options: VerifyOptions,
): Promise<Finding[]> {
  const findings: Finding[] = []
  const error = (message: string): void => {
    findings.push({ level: 'error', message })
  }
  const warning = (message: string): void => {
    findings.push({ level: 'warning', message })
  }
  const { files, manifest, rawManifest } = contents

  // identity
  if (manifest.name !== pkg.name) error(`packed name is ${manifest.name}, expected ${pkg.name}`)
  if (manifest.version !== pkg.version) error(`packed version is ${manifest.version}, expected ${pkg.version}`)

  // dependency ranges rewritten by bun pm pack
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith('workspace:') || range.startsWith('catalog:')) {
        error(`${field}.${name} is still "${range}" (not rewritten by bun pm pack)`)
      } else if (
        field !== 'devDependencies' &&
        options.internal.has(name) &&
        !Bun.semver.satisfies(options.version, range)
      ) {
        error(`${field}.${name} is "${range}", which does not accept the lockstep version ${options.version}`)
      }
    }
  }
  if (/"(workspace|catalog):/.test(rawManifest))
    error('the packed package.json still contains a workspace: or catalog: range')

  // required files
  const fileList = [...files]
  if (!files.has('package/package.json')) error('package.json is missing')
  if (!fileList.some(file => README_ENTRY.test(file))) {
    const message = `README.md is missing (add ${pkg.dir.slice(ROOT.length + 1)}/README.md)`
    if (options.missingReadme === 'error') error(message)
    else warning(`${message}; it is required to publish`)
  }
  if (!fileList.some(file => LICENSE_ENTRY.test(file))) error('LICENSE is missing')
  if (!fileList.some(file => file.startsWith('package/dist/'))) error('dist/ is missing (run `bun run build` first)')

  // entry points
  const targets = new Set<string>()
  exportTargets(manifest.exports, targets)
  for (const field of [manifest.main, manifest.module, manifest.types]) if (field !== undefined) targets.add(field)
  for (const target of targets) {
    if (target.includes('*') || !target.startsWith('./')) continue
    if (!files.has(toEntry(target))) error(`entry point ${target} (exports/main/types) is not in the tarball`)
  }
  for (const target of binTargets(manifest.bin)) {
    const entry = toEntry(target)
    if (!files.has(entry)) {
      error(`bin ${target} is not in the tarball`)
    } else if (!(await readTarballEntry(tarball, entry)).startsWith('#!')) {
      error(`bin ${target} has no shebang (#!/usr/bin/env node)`)
    }
  }

  // unwanted files
  for (const file of fileList) {
    if (FORBIDDEN_ENTRY.test(file)) error(`unexpected file ${file}`)
    else if (TEST_ENTRY.test(file)) warning(`test file shipped: ${file}`)
  }

  // registry metadata
  if (manifest.license === undefined) error('package.json has no "license"')
  const url = repositoryUrl(manifest)
  if (url === undefined || !url.toLowerCase().includes(`github.com/${REPOSITORY.toLowerCase()}`)) {
    error(`repository.url must point to https://github.com/${REPOSITORY} (npm provenance checks it), got ${url}`)
  }
  if (manifest.publishConfig?.access !== 'public') warning('publishConfig.access is not "public"')
  return findings
}

/**
 * Packs and verifies every package (sequentially: the LICENSE copy is written in the package
 * directory) into `outDir`.
 */
export async function packAndVerify(
  packages: readonly WorkspacePackage[],
  outDir: string,
  options: Pick<VerifyOptions, 'missingReadme'>,
): Promise<PackedPackage[]> {
  mkdirSync(outDir, { recursive: true })
  const version = lockstepVersion(packages)
  const internal = new Set(packages.map(pkg => pkg.name))
  const packed: PackedPackage[] = []
  for (const pkg of packages) {
    const tarball = await packPackage(pkg, outDir)
    const contents = await inspectTarball(tarball)
    const findings = await verifyTarball(pkg, tarball, contents, { ...options, version, internal })
    packed.push({ pkg, tarball, size: statSync(tarball).size, fileCount: contents.files.size, findings })
  }
  return packed
}

/** Prints the pack report (and the job summary in GitHub Actions); returns the number of errors. */
export function reportPacked(packed: readonly PackedPackage[]): number {
  let errors = 0
  const rows: string[] = []
  for (const { pkg, size, fileCount, findings } of packed) {
    let status = '✔'
    if (findings.some(finding => finding.level === 'error')) status = '✖'
    else if (findings.length > 0) status = '⚠'
    log.info(`${status} ${pkg.name}@${pkg.version}  ${formatBytes(size)}, ${fileCount} files`)
    rows.push(`| ${status} | \`${pkg.name}@${pkg.version}\` | ${formatBytes(size)} | ${fileCount} |`)
    for (const finding of findings) {
      const message = `${pkg.name}: ${finding.message}`
      if (finding.level === 'error') {
        errors++
        log.error(message)
      } else {
        log.warn(message)
      }
    }
  }
  summary(['### Packed tarballs', '', '| | Package | Size | Files |', '|---|---|---|---|', ...rows, ''].join('\n'))
  return errors
}
