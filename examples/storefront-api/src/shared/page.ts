/**
 * A page of results.
 *
 * A generic interface: each instantiation becomes its own component of the OpenAPI document,
 * named after its type arguments (`Page<ProductSummary>` → `Page_ProductSummary`).
 */
export interface Page<T> {
  readonly items: readonly T[]
  /**
   * Number of results across every page.
   * @format int32
   */
  readonly total: number
  /**
   * Page size.
   * @format int32
   */
  readonly limit: number
  /**
   * Results skipped before this page.
   * @format int32
   */
  readonly offset: number
}
