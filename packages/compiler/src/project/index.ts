/**
 * Project model: the foundation layer of `@znight/compiler` (scan, parse, facts, resolution,
 * packages, identities, import routes, types, static evaluation). See ./README.md.
 */
export type { Diagnostic, DiagnosticSeverity, RelatedInformation } from './diagnostics.ts'
export type { EvaluateOptions, EvaluationError, EvaluationResult, RefMode } from './evaluator.ts'
export type {
  Declaration,
  DeclarationKind,
  DeclarationNode,
  ExportAssignment,
  ExportEntry,
  ExpressionExport,
  FileFacts,
  ImportBinding,
  ImportKind,
  LocalExport,
  ModuleRequest,
  NamespaceReExport,
  ReExport,
  ScopeFacts,
  StarExport,
} from './facts.ts'
export type { FileCacheStats } from './file-cache.ts'
export type { ProjectHost } from './host.ts'
export type { IdentityInfo, IdentityOwner, PublicExport } from './identity.ts'
export type { LibraryDiscovery, LibraryDiscoveryInput, SourceLibrary } from './libraries.ts'
export type { Location, Position, Span } from './location.ts'
export type {
  InterceptorDeclaration,
  ManifestResult,
  PackageManifest,
  ProvidedExternal,
} from './manifest.ts'
export type { OperationResult } from './operators.ts'
export type { FileOwner, PackageEntry, PackageInfo } from './packages.ts'
export type { ParsedSource, ParseError, SourceLanguage } from './parse.ts'
export type { ProjectChanges, RefreshResult, ResolvedIdentifier, ScopeInput } from './project.ts'
export type {
  ModuleResolution,
  ModuleResolverOptions,
  ResolutionMode,
  ResolvedBuiltin,
  ResolvedFile,
  UnresolvedModule,
} from './resolver.ts'
export type { ImportRoute, ImportRouteFailure, ImportRouteFailureReason, ImportRouteResult } from './routes.ts'
export type { ScanOptions } from './scanner.ts'
export type { StaticObject, StaticPrimitive, StaticValue } from './static-value.ts'
export type {
  DeclarationSymbol,
  EntityName,
  ExpressionSymbol,
  ExternalSymbol,
  GlobalSymbol,
  Meaning,
  ModuleSymbol,
  ScopeRef,
  SymbolResolution,
  UnresolvedReason,
  UnresolvedSymbol,
} from './symbols.ts'
export type { HeritageClause, ResolveTypeOptions, TypeParameterInfo, TypeScope } from './type-resolver.ts'
export type {
  ArrayType,
  IntersectionType,
  LiteralType,
  OpaqueReason,
  OpaqueType,
  PrimitiveType,
  PrimitiveTypeName,
  PromiseType,
  ReferenceType,
  TupleElement,
  TupleType,
  TypeInfo,
  TypeParameterType,
  UnionType,
} from './types.ts'

export { compareDiagnostics, DiagnosticBag, diagnosticKey } from './diagnostics.ts'
export { Evaluator } from './evaluator.ts'
export { collectFileFacts, moduleExportName, namespaceFacts } from './facts.ts'
export { FileCache } from './file-cache.ts'
export { contentHash } from './hash.ts'
export { displayNameOf, GLOBAL_IDENTITY_PREFIX, IdentityResolver, splitIdentity } from './identity.ts'
export { discoverLibraries } from './libraries.ts'
export { LineIndex } from './location.ts'
export { MANIFEST_API_VERSION, readManifest } from './manifest.ts'
export { applyBinary, applyUnary } from './operators.ts'
export { PackageRegistry } from './packages.ts'
export { languageOf, parseSource } from './parse.ts'
export {
  isBareSpecifier,
  isDeclarationPath,
  isRelativeSpecifier,
  isResolutionConfigPath,
  isTypeScriptSourcePath,
  packageNameOf,
  publicPackageName,
  realPath,
  relativePath,
  resolvePath,
  toPosixPath,
} from './paths.ts'
export { Project } from './project.ts'
export { ModuleResolver } from './resolver.ts'
export { importSpecifier, RouteResolver } from './routes.ts'
export { ALWAYS_EXCLUDED, scanDirectory } from './scanner.ts'
export { SourceFile } from './source-file.ts'
export { containsRef, describeValue, isStaticPrimitive, ValueRef } from './static-value.ts'
export { declarationKey, pickDeclaration, SymbolResolver, symbolKey } from './symbols.ts'
export { TypeResolver, withTypeParameters } from './type-resolver.ts'
export {
  arrayType,
  formatType,
  freeTypeParameters,
  intersectionType,
  literalType,
  opaqueType,
  primitiveType,
  promiseType,
  referenceType,
  serializeType,
  substituteType,
  tupleType,
  typeParameterType,
  typesEqual,
  unionType,
} from './types.ts'
