/**
 * The diagnostics of RFC 0005 §6.6, formatted like the CLI prints them (code frames, hints, the
 * "reached from" path): one snapshot per example of the RFC.
 */
import { ACCESS, AUTHORS_LOADER, BOOK, CATALOG_SERVICE } from './fixtures.ts'
import { analyzeFiles, cleanupApps, formatted } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const BOOK_WITH_COVER = BOOK.replace(
  '  readonly createdAt: Date\n',
  '  readonly createdAt: Date\n  readonly cover: Uint8Array | null\n',
)

function catalog(resolver: string, book: string = BOOK): Record<string, string> {
  return {
    'src/auth/access.ts': ACCESS,
    'src/catalog/book.ts': book,
    'src/catalog/catalog.service.ts': CATALOG_SERVICE.replace(/import type \{ BookFilter[^\n]*\n/, '')
      .replace(/import type \{ NewBookInput[^\n]*\n/, '')
      .replace(/async list\(filter: BookFilter\)/, 'async list(filter: unknown)')
      .replace(/async add\(input: NewBookInput\)/, 'async add(input: unknown)'),
    'src/catalog/authors-by-id.loader.ts': AUTHORS_LOADER,
    'src/catalog/book.resolver.ts': `import { Args, Mutation, Parent, Query, ResolveField, Resolver, Subscription, type ID } from '@znight/graphql'

import { Public } from '../auth/access.ts'
import type { Author, Book, SearchResult } from './book.ts'
import { CatalogService } from './catalog.service.ts'

@Resolver()
@Public()
export class BookResolver {
  constructor(private readonly catalog: CatalogService) {}

${resolver}
}

void [Args, Mutation, Parent, ResolveField, Subscription]
void (0 as unknown as [Author, Book, SearchResult, ID])
`,
  }
}

const BOOK_QUERY = `  @Query()
  book(@Args('id') id: ID): Promise<Book | null> {
    return this.catalog.find(id)
  }`

describe('formatted diagnostics (RFC 0005 §6.6)', () => {
  it('ZNIGHT060: an unmappable type, with the path from the root field', async () => {
    const result = await analyzeFiles(catalog(BOOK_QUERY, BOOK_WITH_COVER))
    expect(formatted(result)).toMatchSnapshot()
  })

  it('ZNIGHT063: a declaration used as output and as input', async () => {
    const result = await analyzeFiles({
      'src/shared/money.ts': `import type { Int } from '@znight/graphql'

export interface Money {
  readonly amount: Int
  readonly currency: string
}
`,
      'src/catalog/book.ts': `import type { Money } from '../shared/money.ts'

export interface Book {
  readonly title: string
  readonly price: Money
}

export interface NewBookInput {
  readonly title: string
  readonly price: Money
}
`,
      'src/catalog/book.resolver.ts': `import { Args, Mutation, Query, Resolver } from '@znight/graphql'
import type { Book, NewBookInput } from './book.ts'

@Resolver()
export class BookResolver {
  @Query()
  book(): Book | null {
    return null
  }

  @Mutation()
  addBook(@Args('input') input: NewBookInput): Book {
    return { ...input }
  }
}
`,
    })
    expect(formatted(result)).toMatchSnapshot()
  })

  it('ZNIGHT064: union members that cannot be told apart', async () => {
    const result = await analyzeFiles(
      catalog(
        `  @Query()
  search(@Args('text') text: string): Promise<readonly SearchResult[]> {
    return this.catalog.search(text)
  }`,
        BOOK.replace("  readonly kind: 'book'\n", '').replace("  readonly kind: 'author'\n", ''),
      ),
    )
    expect(formatted(result)).toMatchSnapshot()
  })

  it('ZNIGHT062: a field resolver without @Parent(), a subscription without async iterable', async () => {
    const result = await analyzeFiles(
      catalog(`${BOOK_QUERY}

  @ResolveField()
  author(@Args('id') id: ID): Promise<Author> {
    return this.catalog.authors([id]).then(found => found[0] as Author)
  }

  @Subscription()
  bookAdded(): Promise<Book> {
    return null as never
  }`),
    )
    expect(formatted(result)).toMatchSnapshot()
  })

  it('ZNIGHT023: a root field without access decision', async () => {
    const files = catalog(`${BOOK_QUERY}

  @Mutation()
  deleteBook(@Args('id') id: ID): boolean {
    return id !== ''
  }`)
    files['src/catalog/book.resolver.ts'] = (files['src/catalog/book.resolver.ts'] as string).replace(
      '@Resolver()\n@Public()\n',
      '@Resolver()\n',
    )
    files['src/catalog/book.resolver.ts'] = (files['src/catalog/book.resolver.ts'] as string).replace(
      '  @Query()\n  book(',
      '  @Query()\n  @Public()\n  book(',
    )
    const result = await analyzeFiles(files)
    expect(formatted(result)).toMatchSnapshot()
  })
})
