import type { CatalogService } from '../catalog/catalog.service.js'
import type { SearchResult } from './search.js'

import { Args, Query, Resolver } from '@znight/graphql'

import { Public } from '../auth/access.js'

@Resolver()
export class SearchResolver {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Books whose title, and authors whose name, contain the text: books first.
   * @param text Case-insensitive; an empty text finds nothing.
   */
  @Query()
  @Public()
  search(@Args('text') text: string): Promise<readonly SearchResult[]> {
    return this.catalog.search(text)
  }
}
