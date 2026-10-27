/**
 * `@znight/openapi/emit`: writes `openapi.json` (or YAML) at build time (§7.5 of RFC 0002), for
 * `znight openapi`, `znight build --openapi` and the `openapi()` Vite plugin.
 *
 * 1. the compiler options are resolved like `znight generate` does (`znight.config.*`, else the
 *    `znight()` plugin of the Vite config);
 * 2. `compile()` in `serve` mode: errors stop everything before any module runs;
 * 3. a **child process** loads the generated module (Bun: the compiler preload; Node.js: a Vite
 *    server in middleware mode) and runs `buildOpenApiDocument`;
 * 4. each output is written atomically, only when it changed; with `check`, nothing is written and
 *    stale or missing outputs are reported.
 */
import type { Diagnostic } from '@znight/compiler'
import type { OpenApiWarning } from '../build.ts'
import type { OpenApiObject } from '../types.ts'
import type { ChildPayload, ChildResult } from './protocol.ts'

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ErrorCode, ZnightError } from '@znight/core'

import { toYaml } from '../openapi.ts'

/** Runtime loading the application modules: `'auto'` is the runtime running the caller. */
export type EmitRuntime = 'auto' | 'node' | 'bun'

/** Options of {@link emitOpenApi}. */
export interface EmitOpenApiOptions {
  /** Project root. Default `process.cwd()`. */
  readonly root?: string
  /** Output files, relative to `root`; `.yaml` / `.yml` write YAML (optional peer `yaml`). Default `'openapi.json'`. */
  readonly output?: string | readonly string[]
  /** Never write: report missing or stale outputs (`stale`, `staleFiles`). */
  readonly check?: boolean
  /** The HTTP prefix: `servers` defaults to `[{ url: prefix }]` when `@OpenApiDocument` declares none. */
  readonly prefix?: string
  /** Default `'auto'`. */
  readonly runtime?: EmitRuntime
  /** Module (relative to `root`) whose default export is a `SchemaConverter[]`. */
  readonly converters?: string
  /** Vite config file (default: `vite.config.*` of the root). */
  readonly config?: string
  /** How Vite loads its config (`bundle`, `runner`, `native`). */
  readonly configLoader?: string
  /**
   * The compiler options, already resolved (the CLI and the Vite plugin pass theirs). Default:
   * `znight.config.*`, else the options of the `znight()` plugin of the Vite config.
   */
  readonly compilerOptions?: Readonly<Record<string, unknown>>
  /** Environment of the child process. Default `process.env`, with `NODE_ENV` defaulting to `production`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Result of {@link emitOpenApi}. */
export interface EmitOpenApiResult {
  /** `false` when the compile failed (see `diagnostics`): nothing ran and nothing was written. */
  readonly ok: boolean
  /** Outputs written (absolute paths); always empty with `check`. */
  readonly written: readonly string[]
  /** `check`: an output is missing or differs. */
  readonly stale: boolean
  readonly staleFiles: readonly string[]
  /** The document (`undefined` when the compile failed). */
  readonly document: OpenApiObject | undefined
  /** Compiler diagnostics (warnings included). */
  readonly diagnostics: readonly Diagnostic[]
  /** Warnings of the assembly (`unrepresentable: 'warn'`...). */
  readonly warnings: readonly OpenApiWarning[]
  /** Absolute paths of the outputs. */
  readonly outputs: readonly string[]
  readonly runtime: 'node' | 'bun'
}

interface CompilerModule {
  compile(options: Record<string, unknown>): Promise<{
    readonly ok: boolean
    readonly diagnostics: readonly Diagnostic[]
    readonly outFile: string
  }>
  loadZnightConfig?(cwd: string): Promise<{ file: string | undefined; options: Record<string, unknown> }>
}

const VITE_CONFIGS = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
]

/** Compiles the application and writes (or checks) its OpenAPI document. */
export async function emitOpenApi(options: EmitOpenApiOptions = {}): Promise<EmitOpenApiResult> {
  const root = resolve(options.root ?? process.cwd())
  const outputs = (typeof options.output === 'string' ? [options.output] : (options.output ?? ['openapi.json'])).map(
    file => resolve(root, file),
  )
  const runtime = resolveRuntime(options.runtime ?? 'auto')
  const compiler = (await importFromProject(root, '@znight/compiler')) as CompilerModule
  const viteConfig = findViteConfig(root, options.config)
  const compilerOptions =
    options.compilerOptions ?? (await resolveCompilerOptions(root, compiler, viteConfig, options.configLoader))
  const compiled = await compiler.compile({
    ...compilerOptions,
    root: resolve(root, String(compilerOptions['root'] ?? '.')),
    mode: 'serve',
  })
  const base = { outputs, runtime, diagnostics: compiled.diagnostics }
  if (!compiled.ok) {
    return { ...base, ok: false, written: [], stale: false, staleFiles: [], document: undefined, warnings: [] }
  }
  const converters = options.converters === undefined ? undefined : resolve(root, options.converters)
  if (converters !== undefined && !existsSync(converters)) {
    throw new ZnightError(
      ErrorCode.InvalidOpenApiDefinition,
      `The converters module ${options.converters} does not exist`,
    )
  }
  const result = await runChild(
    {
      root,
      runtime,
      outFile: compiled.outFile,
      viteConfig: viteConfig ?? false,
      ...(options.configLoader === undefined ? {} : { configLoader: options.configLoader }),
      compilerOptions: jsonOnly(compilerOptions),
      ...(converters === undefined ? {} : { converters }),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    },
    options.env ?? process.env,
  )
  if (!result.ok) {
    const code =
      Object.values(ErrorCode).find(candidate => candidate === result.error.code) ?? ErrorCode.SchemaConversionFailed
    const message = result.error.message.replace(/^ZNIGHT\d{3}: /, '')
    throw new ZnightError(code, message, { hints: result.error.hints })
  }
  const document = JSON.parse(result.json) as OpenApiObject
  const contents = new Map<string, string>()
  for (const output of outputs) {
    contents.set(output, /\.ya?ml$/i.test(output) ? await toYaml(document) : result.json)
  }
  const staleFiles = outputs.filter(output => readText(output) !== contents.get(output))
  const written: string[] = []
  if (options.check !== true) {
    for (const output of staleFiles) {
      writeAtomically(output, contents.get(output) ?? '')
      written.push(output)
    }
  }
  return {
    ...base,
    ok: true,
    written,
    stale: options.check === true && staleFiles.length > 0,
    staleFiles: options.check === true ? staleFiles : [],
    document,
    warnings: result.warnings,
  }
}

function resolveRuntime(runtime: EmitRuntime): 'node' | 'bun' {
  if (runtime === 'node' || runtime === 'bun') return runtime
  return process.versions['bun'] === undefined ? 'node' : 'bun'
}

/** The Vite config file of the project, if any. */
export function findViteConfig(root: string, config?: string): string | undefined {
  if (config !== undefined) return resolve(root, config)
  return VITE_CONFIGS.map(file => join(root, file)).find(file => existsSync(file))
}

async function resolveCompilerOptions(
  root: string,
  compiler: CompilerModule,
  viteConfig: string | undefined,
  configLoader: string | undefined,
): Promise<Record<string, unknown>> {
  const config = await compiler.loadZnightConfig?.(root)
  if (config?.file !== undefined) {
    const { logLevel: _logLevel, ...rest } = config.options
    return { ...rest, root: resolve(root, String(rest['root'] ?? '.')) }
  }
  if (viteConfig === undefined) return { root }
  const vite = (await importFromProject(root, 'vite')) as {
    resolveConfig?(
      config: Record<string, unknown>,
      command: string,
      mode?: string,
      env?: string,
    ): Promise<{ plugins: readonly unknown[]; root: string }>
  }
  if (typeof vite.resolveConfig !== 'function') return { root }
  const nodeEnv = process.env['NODE_ENV']
  let resolved: { plugins: readonly unknown[]; root: string }
  try {
    resolved = await vite.resolveConfig(
      {
        configFile: viteConfig,
        root,
        mode: 'production',
        logLevel: 'silent',
        ...(configLoader === undefined ? {} : { configLoader }),
      },
      'build',
      'production',
      'production',
    )
  } finally {
    if (nodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = nodeEnv
  }
  for (const plugin of resolved.plugins) {
    const api = (plugin as { name?: unknown; api?: { options?: unknown; compiler?: { options?: { root?: unknown } } } })
      .api
    if ((plugin as { name?: unknown }).name !== 'znight' || api === undefined) continue
    const given =
      typeof api.options === 'object' && api.options !== null ? (api.options as Record<string, unknown>) : {}
    const compilerRoot = api.compiler?.options?.root
    return {
      ...given,
      root: typeof compilerRoot === 'string' ? compilerRoot : resolve(resolved.root, String(given['root'] ?? '.')),
    }
  }
  return { root }
}

async function importFromProject(root: string, specifier: string): Promise<unknown> {
  let resolved: string | undefined
  try {
    resolved = createRequire(join(root, 'package.json')).resolve(specifier)
  } catch {
    resolved = undefined
  }
  try {
    return await import(resolved === undefined ? specifier : pathToFileURL(resolved).href)
  } catch (error) {
    throw new ZnightError(ErrorCode.InvalidOpenApiDefinition, `Cannot load ${specifier}`, {
      cause: error,
      hints: [`Install it in the project: npm install -D ${specifier}`],
    })
  }
}

/** The JSON-compatible part of the compiler options (sent to the child process). */
function jsonOnly(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    try {
      const json = JSON.stringify(value)
      if (json !== undefined && JSON.stringify(JSON.parse(json)) === json && typeof value !== 'function') {
        result[key] = JSON.parse(json)
      }
    } catch {
      // functions, extension objects: the child reads znight.config.* itself
    }
  }
  return result
}

/** The script of the child process (source or built). */
function childScript(): { file: string; source: boolean } {
  const source = import.meta.url.endsWith('.ts')
  return { file: fileURLToPath(new URL(source ? './child.ts' : './emit-child.mjs', import.meta.url)), source }
}

function runChild(
  payload: Omit<ChildPayload, 'result'>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ChildResult> {
  const directory = mkdtempSync(join(tmpdir(), 'znight-openapi-emit-'))
  const payloadFile = join(directory, 'payload.json')
  const resultFile = join(directory, 'result.json')
  const script = childScript()
  writeFileSync(
    payloadFile,
    JSON.stringify({
      ...payload,
      ...(script.source ? { sourceConditions: true } : {}),
      result: resultFile,
    } satisfies ChildPayload),
  )
  const bun = process.versions['bun'] !== undefined
  let executable: string
  if (payload.runtime === 'bun') executable = bun ? process.execPath : 'bun'
  else executable = bun ? 'node' : process.execPath
  const args = [...(script.source ? ['--conditions=@znight/source'] : []), script.file, payloadFile]
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value
  childEnv['NODE_ENV'] ??= 'production'
  return new Promise<ChildResult>((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: payload.root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', error => {
      rmSync(directory, { recursive: true, force: true })
      reject(
        new ZnightError(
          ErrorCode.InvalidOpenApiDefinition,
          `Cannot start ${executable} to load the application modules`,
          {
            cause: error,
            hints: [
              payload.runtime === 'bun'
                ? 'Install Bun, or use --runtime node'
                : 'Install Node.js 24, or use --runtime bun',
            ],
          },
        ),
      )
    })
    child.on('close', code => {
      const text = readText(resultFile)
      rmSync(directory, { recursive: true, force: true })
      if (text === undefined) {
        reject(
          new ZnightError(
            ErrorCode.InvalidOpenApiDefinition,
            `Loading the application modules failed (${executable} exited with code ${String(code)})${output.trim() === '' ? '' : `:\n${output.trim()}`}`,
          ),
        )
        return
      }
      resolvePromise(JSON.parse(text) as ChildResult)
    })
  })
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Writes through a temporary file and a rename (readers never see a partial file). */
function writeAtomically(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, file)
}
