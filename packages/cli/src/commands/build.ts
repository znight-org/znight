/**
 * `znight build`: production build with Vite (the `znight()` plugin compiles the container).
 * `--openapi[=path]` adds the `openapi()` plugin of `@znight/openapi` when the Vite config has none:
 * the OpenAPI document is emitted after the bundle (`dist/openapi.json` by default), with the
 * `servers` of `--openapi-prefix` (the `prefix` of `HttpPlugin`) when `@OpenApiDocument` declares none.
 */
import type { Plugin } from 'vite'
import type { Command } from '../command.ts'
import type { CliContext } from '../context.ts'
import type { OpenApiVitePluginOptionsLike } from '../integrations/openapi.ts'

import { statSync } from 'node:fs'

import { defineCommand } from '../command.ts'
import { CliError, UsageError } from '../errors.ts'
import {
  createOutputTracker,
  formatBuildError,
  runBuild,
  type ViteConfigLoader,
  type ViteLogLevel,
} from '../integrations/vite.ts'
import { formatBytes, formatDuration } from '../output.ts'
import { displayPath, parseHttpPrefix, resolveRoot } from './shared.ts'

/** `znight build` */
export const buildCommand: Command = defineCommand({
  meta: {
    name: 'build',
    description: 'Build the application for production (vite build)',
    usage: '[options]',
    examples: [
      'znight build',
      'znight build --mode staging',
      'znight build --openapi   # also dist/openapi.json',
      'znight build --openapi --openapi-prefix /api   # HttpPlugin.configure({ prefix: "/api" })',
    ],
    details: [
      'Fails on any compiler error. With the defaults of the znight() plugin, src/main.ts is built to dist/main.js.',
      '--openapi emits the OpenAPI document after the bundle (dist/openapi.json, or --openapi=<path>) with the',
      'openapi() Vite plugin of @znight/openapi, unless the Vite config already registers it. When HttpPlugin',
      'has a prefix, pass it with --openapi-prefix: it becomes the servers of the document (unless',
      '@OpenApiDocument declares servers), like the document the application serves in "build" mode.',
    ].join('\n'),
  },
  args: {
    root: { type: 'string', valueHint: 'dir', description: 'Project root (default: the current directory)' },
    config: { type: 'string', valueHint: 'file', description: 'Vite config file (default: vite.config.*)' },
    mode: { type: 'string', default: 'production', description: 'Vite mode' },
    'config-loader': {
      type: 'enum',
      options: ['bundle', 'runner', 'native'],
      description: 'How Vite loads the config file (default: bundle)',
    },
    'log-level': {
      type: 'enum',
      options: ['info', 'warn', 'error', 'silent'],
      default: 'info',
      description: 'Vite log level',
    },
    openapi: {
      type: 'boolean',
      description: 'Also emit the OpenAPI document (dist/openapi.json, or --openapi=<path>; needs @znight/openapi)',
    },
    'openapi-prefix': {
      type: 'string',
      valueHint: 'path',
      description: 'With --openapi: the HTTP prefix of HttpPlugin, the servers default of the document (/api)',
    },
  },
  async run({ args, cli, rawArgs }) {
    const root = resolveRoot(cli, args.root)
    const openapi = openapiOption(rawArgs, args.openapi)
    const prefix = parseHttpPrefix(args['openapi-prefix'], 'openapi-prefix')
    if (prefix !== undefined && openapi === undefined) {
      throw new UsageError('--openapi-prefix needs --openapi', [`znight build --openapi --openapi-prefix ${prefix}`])
    }
    const vite = await cli.services.loadVite(root)
    const tracker = createOutputTracker(root)
    const extra: Plugin[] = []
    if (openapi !== undefined) {
      const api = await cli.services.loadOpenApiVite(root)
      const options: OpenApiVitePluginOptionsLike = {
        ...(openapi === true ? {} : { output: openapi }),
        ...(prefix === undefined ? {} : { prefix }),
      }
      const plugin = api.openapi(options)
      extra.push(plugin)
      const given = [
        ...(options.output === undefined ? [] : [`--openapi=${options.output}`]),
        ...(options.prefix === undefined ? [] : [`--openapi-prefix ${options.prefix}`]),
      ]
      if (given.length > 0) extra.push(ignoredOpenApiOptions(cli, plugin, given))
    }
    const started = performance.now()
    try {
      await runBuild(vite, {
        root,
        configFile: args.config,
        configLoader: args['config-loader'] as ViteConfigLoader | undefined,
        mode: args.mode,
        logLevel: args['log-level'] as ViteLogLevel,
        plugins: [tracker.plugin, ...extra],
      })
    } catch (error) {
      // like the Vite CLI: the (enhanced) error message carries the location and the code frame
      cli.reporter.logError(formatBuildError(error))
      throw new CliError('Build failed', { cause: error })
    }
    const entry = tracker.entry()
    const duration = formatDuration(performance.now() - started)
    if (entry === undefined) {
      cli.reporter.success(`Built in ${duration}`)
      return 0
    }
    let size = ''
    try {
      size = ` ${cli.colors.dim(formatBytes(statSync(entry).size))}`
    } catch {
      size = ''
    }
    cli.reporter.success(`Built ${cli.colors.bold(displayPath(entry, cli.cwd))}${size} in ${duration}`)
    cli.reporter.log(`  ${cli.colors.dim('run it with')} ${cli.colors.cyan('znight start')}`)
    return 0
  },
})

/** `--openapi` (`true`), `--openapi=<path>` (the path), or `undefined`. */
function openapiOption(rawArgs: readonly string[], parsed: unknown): true | string | undefined {
  for (const token of rawArgs) {
    if (token.startsWith('--openapi=')) {
      const value = token.slice('--openapi='.length)
      if (value === 'false') return undefined
      return value === '' || value === 'true' ? true : value
    }
    if (token === '--no-openapi') return undefined
  }
  return parsed === true || rawArgs.includes('--openapi') ? true : undefined
}

/**
 * When the Vite config registers its own `openapi()`, that one emits the document and the copy of the
 * CLI stays inactive: the options given on the command line (`given`) do not apply. Says so, instead
 * of emitting a document without the requested output or prefix.
 */
function ignoredOpenApiOptions(cli: CliContext, plugin: Plugin, given: readonly string[]): Plugin {
  return {
    name: 'znight:cli-openapi-options',
    apply: 'build',
    configResolved(config) {
      const active = config.plugins.find(candidate => candidate.name === plugin.name)
      if (active === undefined || active === plugin) return
      cli.reporter.warn(
        `${given.join(' and ')} ignored: the openapi() plugin of the Vite config emits the document with its own options`,
        ['set them on openapi() in the Vite config (openapi({ output, prefix })), or remove it from there'],
      )
    },
  }
}
