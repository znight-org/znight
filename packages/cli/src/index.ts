/**
 * `@znight/cli`: the `znight` command (`znight new`, `generate`, `g`, `dev`, `build`, `start`).
 *
 * The programmatic API runs the CLI in-process (`main(['build'])`) and exposes the pure building
 * blocks: project templates, schematics and the restart supervisor of `znight dev`.
 */
export type { Command, CommandDefinition, CommandMeta, CommandRunContext } from './command.ts'
export type { CliContext, CliContextOptions, CliServices, SignalSource } from './context.ts'
export type {
  AppSupervisorOptions,
  SupervisorEvents,
} from './dev/supervisor.ts'
export type {
  CheckResultLike,
  CompileResultLike,
  CompilerApi,
  CompilerChanges,
  CompilerModule,
  Diagnostic,
  DiagnosticLocation,
  FormatDiagnosticsOptions,
  GenerateResultLike,
  IncrementalCompiler,
  ZnightConfigLike,
  ZnightOptions,
} from './integrations/compiler.ts'
export type {
  OpenApiEmitApi,
  OpenApiEmitOptionsLike,
  OpenApiEmitResultLike,
  OpenApiViteApi,
  OpenApiVitePluginOptionsLike,
  OpenApiWarningLike,
} from './integrations/openapi.ts'
export type {
  ChildHandle,
  ExecveFunction,
  ExitStatus,
  ProcessService,
  RunOptions,
  RunResult,
  SpawnOptions,
} from './integrations/process.ts'
export type { PromptChoice, Prompts } from './integrations/prompts.ts'
export type { FileWatcher, WatchFactory, WatchTarget } from './integrations/watch.ts'
export type { OutputStream, Reporter } from './output.ts'
export type { HostRuntime, RuntimeName, RuntimeOption } from './runtime.ts'
export type {
  Feature,
  HttpAdapterName,
  PackageManager,
  ProjectOptions,
} from './scaffold/options.ts'
export type { ProjectFile } from './scaffold/templates.ts'
export type {
  PlanSchematicOptions,
  Schematic,
  SchematicContext,
  SchematicName,
  SchematicNames,
  SchematicPlan,
} from './schematics/index.ts'

export { defineCommand } from './command.ts'
export { createContext } from './context.ts'
export { AppSupervisor } from './dev/supervisor.ts'
export { CancelledError, CliError, ExitCode, UsageError } from './errors.ts'
export { adaptCompilerModule, loadCompiler } from './integrations/compiler.ts'
export { COMMANDS, main } from './main.ts'
export { DEFAULT_FEATURES, FEATURES, HTTP_ADAPTERS, PACKAGE_MANAGERS } from './scaffold/options.ts'
export { renderProject } from './scaffold/templates.ts'
export { findSchematic, planSchematic, SCHEMATICS } from './schematics/index.ts'
export { cliVersion } from './version.ts'
