/**
 * `@znight/compiler`: compile-time dependency injection for Znight applications.
 *
 * This entry exposes the Vite plugin (`znight`, also the default export), the Bun API
 * (`createPreload`, `znightBunPlugin`, `loadZnightConfig`; the ready-made preload is
 * `@znight/compiler/bun`), the programmatic API (`compile`, `generate`, `createCompiler`,
 * `formatDiagnostics`, `renderErrorModule`), the options, the analysis API (analysis → binding →
 * validation → application graph) and the public compiler extension API (§6.5).
 *
 * Compiler extensions (`@znight/<pkg>/compiler`) must only `import type` from this package.
 */

export type {
  AnalysisInternals,
  AnalysisResult,
  AnalysisStats,
  AnalyzeOptions,
} from './analyze.ts'
export type {
  BunLoader,
  BunOnLoadArgs,
  BunOnLoadResult,
  BunPluginBuild,
  LoadedZnightConfig,
  PreloadOptions,
  ZnightBunPlugin,
  ZnightBunPluginOptions,
} from './bun-plugin.ts'
export type { RenderErrorModuleOptions } from './codegen/error-module.ts'
export type {
  CompileMode,
  CompileOptions,
  CompileResult,
  CompileStats,
  GenerateOptions,
  GenerateResult,
  ZnightCompiler,
} from './compiler.ts'
export type { DecoratorRanges } from './decorator-ranges.ts'
export type { FormatDiagnosticsOptions } from './diagnostics/format.ts'
export type {
  AnalyzeContext,
  ArgInfo,
  ArgKind,
  BindingHandle,
  ClassInfo,
  ClassRef,
  ClassRefOptions,
  CompilerExtension,
  ConstructorInfo,
  CustomFactory,
  DecoratorInfo,
  DecoratorSpec,
  DecoratorTarget,
  DependencyDetails,
  FactoryInput,
  InjectionRequest,
  LifecycleHookInfo,
  LifecycleHookName,
  MethodInfo,
  ParameterInfo,
  ParameterPropertyInfo,
  PropertyInfo,
  ProviderRegistration,
  TypeHelpers,
  ValidateContext,
  Visibility,
} from './extensions/api.ts'
export type {
  GenArray,
  GenArrow,
  GenBuilders,
  GenCall,
  GenCode,
  GenConstant,
  GenerateContext,
  GenImport,
  GenInput,
  GenLiteral,
  GenMember,
  GenNode,
  GenObject,
  GenParam,
  LiteralValue,
} from './extensions/generate.ts'
export type {
  DiscoveredExtensionModule,
  ExtensionLoadResult,
  LoadExtensionsOptions,
  LoadedExtension,
} from './extensions/loader.ts'
export type {
  AliasNode,
  ApplicationGraph,
  BindingRequestNode,
  DependencyNode,
  DependencyRole,
  EdgeKind,
  ExtensionGraphData,
  ExternalNode,
  FactoryNode,
  GraphEdge,
  InjectionRequestNode,
  InterceptedMethodNode,
  InterceptorLinkNode,
  ProviderKind,
  ProviderNode,
  Reachability,
} from './graph/types.ts'
export type { EmitLibraryResult, LibraryOutput } from './library/emit.ts'
export type {
  EncodedValue,
  LibraryBinding,
  LibraryEdge,
  LibraryImportRoute,
  LibraryInjection,
  LibraryInterceptedMethod,
  LibraryInterceptorLink,
  LibraryProvider,
  ProvidersFile,
} from './library/schema.ts'
export type {
  AppOptions,
  CompilerExtensionLike,
  ImportExtension,
  NormalizeOptionsContext,
  ResolvedOptions,
  SourceLocationsMode,
  StringAlias,
  ZnightOptions,
} from './options.ts'
export type {
  ArrayType,
  Diagnostic,
  DiagnosticSeverity,
  ImportRoute,
  ImportRouteFailure,
  IntersectionType,
  LiteralType,
  Location,
  OpaqueReason,
  OpaqueType,
  PrimitiveType,
  PrimitiveTypeName,
  ProjectChanges,
  PromiseType,
  ReferenceType,
  RelatedInformation,
  StaticObject,
  StaticPrimitive,
  StaticValue,
  TupleElement,
  TupleType,
  TypeInfo,
  TypeParameterType,
  UnionType,
} from './project/index.ts'
export type { ZnightPluginApi } from './vite.ts'

export { analyze, analyzeProject } from './analyze.ts'
export { createPreload, loadZnightConfig, ZNIGHT_CONFIG_FILES, znightBunPlugin } from './bun-plugin.ts'
export { renderErrorModule } from './codegen/error-module.ts'
export { compile, createCompiler, generate } from './compiler.ts'
export { formatDiagnostics } from './diagnostics/format.ts'
export { EXTENSION_API_VERSION } from './extensions/api.ts'
export { createGenBuilders, isGenNode } from './extensions/generate.ts'
export { discoverExtensionModules, loadExtensions, validateExtension } from './extensions/loader.ts'
export { PROVIDERS_FILE, PROVIDERS_SCHEMA_VERSION } from './library/schema.ts'
export {
  DEFAULT_APP_ENTRY,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  DEFAULT_OUT_FILE,
  DEFAULT_RUNTIME_CONDITIONS,
  DEFAULT_SCAN_CONDITIONS,
  normalizeOptions,
  SOURCE_CONDITION,
} from './options.ts'
export { Project, ValueRef } from './project/index.ts'
export { COMPILER_VERSION } from './version.ts'
export { znight as default, znight } from './vite.ts'
