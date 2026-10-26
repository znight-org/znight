/** Writing a new project to disk, initialising git and installing dependencies. */
import type { ProcessService, RunResult } from '../integrations/process.ts'
import type { PackageManager } from './options.ts'
import type { ProjectFile } from './templates.ts'

import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { installCommand } from './options.ts'

/** Entries tolerated in the target directory (a fresh clone, editor settings). */
const IGNORABLE_ENTRIES = new Set(['.git', '.DS_Store', 'Thumbs.db', '.idea', '.vscode'])

/** State of the target directory of `znight new`. */
export type TargetState = 'missing' | 'empty' | 'not-empty' | 'file'

/** Inspects the target directory. */
export function targetState(directory: string): TargetState {
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(directory)
  } catch {
    return 'missing'
  }
  if (!stats.isDirectory()) return 'file'
  return readdirSync(directory).every(entry => IGNORABLE_ENTRIES.has(entry)) ? 'empty' : 'not-empty'
}

/** Writes `files` under `directory` (created when missing). Returns the written paths. */
export function writeProject(directory: string, files: readonly ProjectFile[]): string[] {
  mkdirSync(directory, { recursive: true })
  for (const file of files) {
    const target = join(directory, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
  }
  return files.map(file => file.path)
}

/** Outcome of {@link initGit}. */
export type GitOutcome = 'initialized' | 'inside-repository' | 'unavailable' | 'failed'

/** `git init` in `directory`, unless it already is inside a git work tree (monorepos). */
export async function initGit(
  processes: ProcessService,
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<GitOutcome> {
  const inside = await processes.run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: directory, env })
  if (inside.error !== undefined) return 'unavailable'
  if (inside.code === 0 && inside.stdout.trim() === 'true') return 'inside-repository'
  const init = await processes.run('git', ['init', '--quiet'], { cwd: directory, env })
  return init.code === 0 ? 'initialized' : 'failed'
}

/** `<pm> install` in `directory`, output captured. */
export function installDependencies(
  processes: ProcessService,
  directory: string,
  packageManager: PackageManager,
  env: Readonly<Record<string, string | undefined>>,
): Promise<RunResult> {
  const [command, ...args] = installCommand(packageManager)
  return processes.run(command, args, { cwd: directory, env })
}
