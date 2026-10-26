/**
 * `@znight/compiler`: compile-time analysis of Znight applications.
 *
 * This entry exposes the options, the analysis API (analysis → binding → validation → application
 * graph) and the public compiler extension API (§6.5). Code generation and the Vite plugin are
 * added by later phases.
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
  GenerateContext,
  GenImport,
  GenInput,
  GenLiteral,
  GenMember,
  GenNode,
  GenObject,
  GenParam,
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
  DependencyNode,
  DependencyRole,
  EdgeKind,
  ExtensionGraphData,
  ExternalNode,
  FactoryNode,
  GraphEdge,
  InterceptedMethodNode,
  InterceptorLinkNode,
  ProviderKind,
  ProviderNode,
  Reachability,
} from './graph/types.ts'
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

export { analyze, analyzeProject } from './analyze.ts'
export { EXTENSION_API_VERSION } from './extensions/api.ts'
export { createGenBuilders, isGenNode } from './extensions/generate.ts'
export { discoverExtensionModules, loadExtensions, validateExtension } from './extensions/loader.ts'
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
