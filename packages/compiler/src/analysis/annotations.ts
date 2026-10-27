/**
 * Where the type annotations of analysed members come from, so that `TypeHelpers.shape()` can go
 * back from a `MethodInfo` / `ParameterInfo` / `PropertyInfo` / `DecoratorInfo` to the annotation
 * (AST node and lexical scope) instead of the already resolved `TypeInfo`, which loses alias names
 * and object literal types.
 */
import type { TSType } from 'oxc-parser'
import type { ScopeRef, TypeInfo } from '../project/index.ts'

/** A type annotation and the scope it is written in. */
export interface AnnotationSite {
  readonly scope: ScopeRef
  /** Type parameter names in scope (class and method type parameters): unbound in shapes. */
  readonly typeParameters: readonly string[]
  /** The annotation(s): one for members and parameters, the type arguments for decorators. */
  readonly nodes: readonly (TSType | undefined)[]
  /** Type parameters substituted by inheritance (constructors inherited from a generic base). */
  readonly bindings: ReadonlyMap<string, TypeInfo>
}

const SITES = new WeakMap<object, AnnotationSite>()

/** Records the annotation site of an analysed object (`MethodInfo`, `ParameterInfo`...). */
export function recordAnnotation(target: object, site: AnnotationSite): void {
  SITES.set(target, site)
}

/** The annotation site of an analysed object, when the compiler built it. */
export function annotationOf(target: object): AnnotationSite | undefined {
  return SITES.get(target)
}
