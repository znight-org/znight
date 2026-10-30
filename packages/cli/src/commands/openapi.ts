/**
 * `znight openapi`: writes the OpenAPI document of the application (`openapi.json`, or YAML by
 * extension) with `@znight/openapi/emit`, or checks that the committed file is up to date
 * (`--check`, for CI). The modules of the application run in a child process.
 */
import type { Command } from '../command.ts'
import type { CliContext } from '../context.ts'
import type { CompilerApi, Diagnostic } from '../integrations/compiler.ts'
import type { OpenApiEmitResultLike } from '../integrations/openapi.ts'
import type { ViteConfigLoader } from '../integrations/vite.ts'

import { existsSync } from 'node:fs'

import { defineCommand } from '../command.ts'
import { CliError, errorMessage } from '../errors.ts'
import { hasErrors } from '../integrations/compiler.ts'
import { formatDuration, plural } from '../output.ts'
import { compilerOptions } from './generate.ts'
import { displayPath, parseHttpPrefix, resolveRoot } from './shared.ts'

/** Values of a repeatable string option (`-o a -o b`, `--output=a`, `--output b,c`). */
export function repeatedOption(rawArgs: readonly string[], name: string, alias: string): string[] {
  const values: string[] = []
  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index] ?? ''
    let value: string | undefined
    if (token === `--${name}` || token === `-${alias}`) value = rawArgs[++index]
    else if (token.startsWith(`--${name}=`)) value = token.slice(name.length + 3)
    else if (token.startsWith(`-${alias}=`)) value = token.slice(alias.length + 2)
    if (value === undefined) continue
    for (const part of value.split(',')) if (part.trim() !== '') values.push(part.trim())
  }
  return values
}

/** `znight openapi` */
export const openapiCommand: Command = defineCommand({
  meta: {
    name: 'openapi',
    description: 'Emit the OpenAPI document of the application (openapi.json, --check in CI)',
    usage: '[options]',
    examples: [
      'znight openapi                      # writes openapi.json at the project root',
      'znight openapi -o docs/openapi.yaml # YAML, chosen by the extension (needs yaml)',
      'znight openapi --check              # CI: exit 1 when the file is missing or stale',
      'znight openapi --prefix /api        # servers default when @OpenApiDocument declares none',
      'znight openapi --runtime bun        # load the modules with Bun',
    ],
    details: [
      'The application is compiled like "znight generate" (compile errors stop everything), then its',
      'generated module is loaded in a child process (Bun: the compiler preload; Node.js: a Vite server)',
      'and @znight/openapi assembles the document. Nothing is instantiated. Outputs are only written',
      'when they change. Requires @znight/openapi in the project.',
    ].join('\n'),
  },
  args: {
    output: {
      type: 'string',
      alias: 'o',
      valueHint: 'file',
      description: 'Output file, repeatable (.yaml / .yml write YAML). Default: openapi.json',
    },
    check: { type: 'boolean', description: 'Do not write: exit with code 1 when an output is missing or stale' },
    prefix: { type: 'string', valueHint: 'path', description: 'HTTP prefix: the servers default (/api)' },
    runtime: {
      type: 'enum',
      options: ['auto', 'node', 'bun'],
      description: 'Runtime loading the application modules (default: auto, the one running the CLI)',
    },
    converters: {
      type: 'string',
      valueHint: 'file',
      description: 'Module whose default export is a SchemaConverter[] (custom schema libraries)',
    },
    root: { type: 'string', valueHint: 'dir', description: 'Project root (default: the current directory)' },
    config: { type: 'string', valueHint: 'file', description: 'Vite config file (default: vite.config.*)' },
    'config-loader': {
      type: 'enum',
      options: ['bundle', 'runner', 'native'],
      description: 'How Vite loads the config file (default: bundle)',
    },
  },
  async run({ args, cli, rawArgs }) {
    const root = resolveRoot(cli, args.root)
    const outputs = repeatedOption(rawArgs, 'output', 'o')
    const prefix = parseHttpPrefix(args.prefix, 'prefix')
    const compiler = await cli.services.loadCompiler(root)
    const configLoader = args['config-loader'] as ViteConfigLoader | undefined
    const options = await compilerOptions(cli, compiler, root, args.config, configLoader)
    const openapi = await cli.services.loadOpenApi(root)
    const started = performance.now()
    let result: OpenApiEmitResultLike
    try {
      result = await openapi.emitOpenApi({
        root,
        output: outputs.length > 0 ? outputs : ['openapi.json'],
        ...(args.check === true ? { check: true } : {}),
        ...(prefix === undefined ? {} : { prefix }),
        ...(args.runtime === undefined ? {} : { runtime: args.runtime as 'auto' | 'node' | 'bun' }),
        ...(args.converters === undefined ? {} : { converters: args.converters }),
        ...(args.config === undefined ? {} : { config: args.config }),
        ...(configLoader === undefined ? {} : { configLoader }),
        compilerOptions: options,
      })
    } catch (error) {
      const hints = (error as { hints?: unknown } | null)?.hints
      throw new CliError(`OpenAPI emission failed: ${errorMessage(error)}`, {
        cause: error,
        hints: Array.isArray(hints) ? (hints as string[]) : [],
      })
    }
    printDiagnostics(cli, compiler, result.diagnostics, root)
    if (!result.ok || hasErrors(result.diagnostics)) {
      const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
      cli.reporter.error(`OpenAPI emission failed: the application does not compile (${plural(errors, 'error')})`)
      return 1
    }
    for (const warning of result.warnings) cli.reporter.warn(`${warning.code}: ${warning.message}`)
    const elapsed = formatDuration(performance.now() - started)
    const operations = Object.values(result.document?.paths ?? {}).reduce(
      (count, item) => count + Object.keys(item).length,
      0,
    )
    const stats = cli.colors.dim(`(${plural(operations, 'operation')}, ${result.runtime}, ${elapsed})`)
    if (args.check === true) {
      for (const file of result.staleFiles) {
        const shown = displayPath(file, cli.cwd)
        if (existsSync(file))
          cli.reporter.error(`${shown} is out of date`, ['run "znight openapi" and commit the result'])
        else cli.reporter.error(`${shown} is missing`, ['run "znight openapi" and commit the result'])
      }
      if (result.stale) return 1
      cli.reporter.success(
        `${result.outputs.map(file => cli.colors.bold(displayPath(file, cli.cwd))).join(', ')} up to date ${stats}`,
      )
      return 0
    }
    for (const file of result.outputs) {
      const shown = cli.colors.bold(displayPath(file, cli.cwd))
      cli.reporter.success(`${result.written.includes(file) ? 'Wrote' : 'Up to date:'} ${shown} ${stats}`)
    }
    return 0
  },
})

function printDiagnostics(
  cli: CliContext,
  compiler: CompilerApi,
  diagnostics: readonly Diagnostic[],
  root: string,
): void {
  if (diagnostics.length === 0) return
  const text = compiler.formatDiagnostics(diagnostics, {
    color: cli.colors.isColorSupported,
    cwd: root,
    summary: false,
  })
  cli.reporter.logError(text.trimEnd())
  cli.reporter.logError()
}
