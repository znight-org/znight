/**
 * ZNIGHT020: a provider module imports — directly or through other scanned modules — the generated
 * module. The generated module imports every provider, so this is an ESM cycle: depending on the
 * evaluation order a provider class is read before its module ran (TDZ crash at startup).
 *
 * Only static, non-type-only imports and re-exports count (`import type` is erased, `import()` is
 * lazy). The generated file may not exist yet (fresh checkout): relative specifiers are then
 * compared by path, and aliased ones (tsconfig `paths`, package `imports`, Vite aliases) are checked
 * with a probe, so the diagnostic never depends on the disk copy.
 */
import type { Reporter } from '../analysis/arguments.ts'
import type { ModuleRequest, Project, SourceFile } from '../project/index.ts'

import { ErrorCode } from '@znight/core'

import { isRelativeSpecifier, relativePath, resolvePath } from '../project/index.ts'

interface Hop {
  /** Next module towards the generated module. */
  readonly next: string
  readonly request: ModuleRequest
}

/** Reports every provider module that transitively imports `outFile`. */
export function checkGeneratedModuleImports(
  project: Project,
  providerFiles: ReadonlySet<string>,
  report: Reporter,
): void {
  const outFile = project.options.outFile
  const importers = new Map<string, { readonly file: SourceFile; readonly request: ModuleRequest }[]>()
  for (const file of project.files()) {
    for (const request of file.facts.moduleRequests) {
      if (request.typeOnly) {
        continue
      }
      const target = targetOf(project, file, request, outFile)
      if (target === undefined || (target !== outFile && !project.isScanned(target))) {
        continue
      }
      const list = importers.get(target)
      if (list) {
        list.push({ file, request })
      } else {
        importers.set(target, [{ file, request }])
      }
    }
  }
  if (!importers.has(outFile)) {
    return
  }

  // Breadth-first from the generated module over reverse import edges: shortest chains.
  const hops = new Map<string, Hop>()
  const queue = [outFile]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const importer of importers.get(current) ?? []) {
      const path = importer.file.path
      if (path === outFile || hops.has(path)) {
        continue
      }
      hops.set(path, { next: current, request: importer.request })
      queue.push(path)
    }
  }

  for (const file of [...providerFiles].sort()) {
    const hop = hops.get(file)
    const source = project.getFile(file)
    if (!hop || !source) {
      continue
    }
    const chain = [file]
    let current: Hop | undefined = hop
    while (current) {
      chain.push(current.next)
      current = hops.get(current.next)
    }
    const display = chain.map(path => relativePath(project.root, path))
    const through = display.length > 2 ? ` through ${display.slice(1, -1).join(', ')}` : ''
    report({
      code: ErrorCode.GeneratedModuleCycle,
      severity: 'error',
      message: `The provider module ${display[0]} imports the generated module ${display[display.length - 1]}${through}: ${display.join(' -> ')}`,
      location: source.location(hop.request.span),
      hints: [
        'The generated module imports every provider: importing it from a provider module creates an ESM cycle (TDZ errors at startup)',
        'Import the generated module only from the application entry point (src/main.ts)',
      ],
    })
  }
}

/** Resolved target of an import; when the outFile does not exist, specifiers naming it still target it. */
function targetOf(project: Project, file: SourceFile, request: ModuleRequest, outFile: string): string | undefined {
  const resolution = project.resolveModule(file.path, request.specifier)
  if (resolution.kind === 'file') {
    return resolution.path
  }
  if (resolution.kind !== 'not-found') {
    return undefined
  }
  if (isRelativeSpecifier(request.specifier)) {
    const candidate = resolvePath(request.specifier, file.path.slice(0, file.path.lastIndexOf('/')))
    return stripExtension(candidate) === stripExtension(outFile) ? outFile : undefined
  }
  return aliasesOutFile(project, file, request.specifier, outFile) ? outFile : undefined
}

/**
 * Whether an aliased specifier that does not resolve (yet) names the outFile:
 * `@/.znight/container.generated.js` with tsconfig `paths: { "@/*": ["./src/*"] }`. The specifier
 * must end with the trailing path segments of the outFile (its file name, then its directories);
 * the remaining prefix (`@`) must map to the remaining directory (`<root>/src`), which is checked by
 * resolving the prefix followed by the path of a scanned file of that directory (`@/svc.ts`).
 */
function aliasesOutFile(project: Project, file: SourceFile, specifier: string, outFile: string): boolean {
  const segments = specifier.split('/')
  const target = outFile.split('/')
  if (stripExtension(segments[segments.length - 1] ?? '') !== stripExtension(target[target.length - 1] ?? '')) {
    return false
  }
  for (let shared = 1; shared < segments.length && shared < target.length; shared++) {
    if (shared > 1 && segments[segments.length - shared] !== target[target.length - shared]) {
      return false
    }
    const directory = target.slice(0, target.length - shared).join('/')
    const probe = project.scannedFiles().find(path => path.startsWith(`${directory}/`))
    if (probe === undefined) {
      continue
    }
    const prefix = segments.slice(0, segments.length - shared).join('/')
    const resolution = project.resolveModule(file.path, `${prefix}/${relativePath(directory, probe)}`)
    if (resolution.kind === 'file' && resolution.path === probe) {
      return true
    }
  }
  return false
}

function stripExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/, '')
}
