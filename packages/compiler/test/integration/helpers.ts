/**
 * Helpers of the Vite plugin / Bun preload integration tests: temporary copies of
 * `test/fixtures/integration/<name>` with `@znight/core`, `@znight/compiler` and `vite` linked into
 * their `node_modules`, process spawning, waiting.
 *
 * In this repository the packages are used from their TypeScript sources: Vite resolves
 * `@znight/core` with the `@znight/source` condition (and bundles it, it is a linked package), and
 * spawned processes get `--conditions=@znight/source`.
 */
import type { InlineConfig, Logger } from 'vite'
import type { TempDir } from '../project/helpers.ts'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultServerConditions } from 'vite'

import { realPath } from '../../src/project/index.ts'
import { CORE } from '../analysis/helpers.ts'
import { FIXTURES, tempDir } from '../project/helpers.ts'

/** Real path of `packages/compiler`. */
export const COMPILER_PACKAGE: string = realPath(fileURLToPath(new URL('../..', import.meta.url))) as string

/** Real path of the `vite` package used by the tests. */
export const VITE_PACKAGE: string = realPath(
  path.dirname(fileURLToPath(import.meta.resolve('vite/package.json'))),
) as string

/** The `@znight/source` condition (packages loaded from their TypeScript sources). */
export const SOURCE_CONDITION = '--conditions=@znight/source'

/** Directory of the fixture `test/fixtures/integration/<name>`. */
export function integrationTemplate(name: string): string {
  return `${FIXTURES}/integration/${name}`
}

/** A temporary copy of `test/fixtures/integration/<name>`, with files added or replaced. */
export function integrationApp(name: string, files: Record<string, string> = {}): TempDir {
  const template = integrationTemplate(name)
  const dir = tempDir()
  fs.cpSync(template, dir.root, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    dir.write(relative, content)
  }
  link(dir.root, '@znight/core', CORE)
  link(dir.root, '@znight/compiler', COMPILER_PACKAGE)
  link(dir.root, 'vite', VITE_PACKAGE)
  return dir
}

function link(root: string, name: string, target: string): void {
  const file = `${root}/node_modules/${name}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.symlinkSync(target, file, 'dir')
}

/** A Vite logger recording every message (`info`, `warn`, `error`), without printing. */
export interface RecordingLogger extends Logger {
  readonly messages: { readonly type: 'info' | 'warn' | 'error'; readonly text: string }[]
  /** Every message of a type, ANSI codes removed. */
  text(type?: 'info' | 'warn' | 'error'): string
}

export function recordingLogger(): RecordingLogger {
  const messages: { type: 'info' | 'warn' | 'error'; text: string }[] = []
  const warned = new Set<string>()
  const logger: RecordingLogger = {
    messages,
    hasWarned: false,
    info: text => {
      messages.push({ type: 'info', text })
    },
    warn: text => {
      logger.hasWarned = true
      messages.push({ type: 'warn', text })
    },
    warnOnce: text => {
      if (!warned.has(text)) {
        warned.add(text)
        logger.warn(text)
      }
    },
    error: text => {
      messages.push({ type: 'error', text })
    },
    clearScreen: () => {},
    hasErrorLogged: () => false,
    text: type =>
      messages
        .filter(message => type === undefined || message.type === type)
        .map(message => stripAnsi(message.text))
        .join('\n'),
  }
  return logger
}

/** Removes ANSI escape sequences. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/**
 * Inline Vite config of a fixture app: no config file, `@znight/core` resolved from its sources,
 * a recording logger.
 */
export function viteConfig(root: string, logger: Logger, config: InlineConfig = {}): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: 'info',
    customLogger: logger,
    clearScreen: false,
    ssr: { resolve: { conditions: ['@znight/source', ...defaultServerConditions] } },
    ...config,
  }
}

/** Result of {@link run}. */
export interface RunResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs a command to completion (no color, `cwd` = `root`). */
export async function run(
  command: readonly string[],
  root: string,
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const child = Bun.spawn([...command], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

/** Waits until `predicate` holds (polling), failing after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await sleep(20)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The JSON report printed by the fixture app (`src/main.ts`). */
export function report(stdout: string): { readonly greeting: string; readonly providers: readonly string[] } {
  const line = stdout.split('\n').find(candidate => candidate.startsWith('{'))
  if (line === undefined) {
    throw new Error(`no report in the output:\n${stdout}`)
  }
  return JSON.parse(line)
}
