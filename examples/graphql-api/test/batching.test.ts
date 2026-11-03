import { executeOperation } from '@znight/graphql/testing'

import { AuthorRepository } from '../src/catalog/author.repository.js'
import { BookRepository } from '../src/catalog/book.repository.js'
import { ReviewRepository } from '../src/reviews/review.repository.js'
import { createTestApp } from './support/app.js'
import { describe, expect, test as it, spyOn } from 'bun:test'

/*
 * The N+1 trap: six books, and a field resolver loading the author of each. Loaders batch the keys
 * requested during one execution: one repository call, whatever the number of books.
 */
describe('batching with loaders', () => {
  it('loads the authors of every book in one call, each author once', async () => {
    await using app = await createTestApp()
    const findMany = spyOn(app.get(AuthorRepository), 'findMany')

    const res = await executeOperation<{ books: { items: { author: { name: string } }[] } }>(app, {
      query: '{ books { items { title author { name } } } }',
    })

    expect(res.errors).toBeUndefined()
    expect(res.data?.books.items).toHaveLength(6)
    expect(findMany).toHaveBeenCalledTimes(1) // no N+1
    expect([...(findMany.mock.calls[0]?.[0] ?? [])].sort()).toEqual(['a1', 'a2', 'a3', 'a4']) // deduplicated
  })

  it('starts a fresh batch (and a fresh cache) for every operation', async () => {
    await using app = await createTestApp()
    const findMany = spyOn(app.get(AuthorRepository), 'findMany')

    await executeOperation(app, { query: '{ books { items { author { name } } } }' })
    await executeOperation(app, { query: '{ books { items { author { name } } } }' })

    expect(findMany).toHaveBeenCalledTimes(2) // values never leak from one request to another
  })

  it('batches field resolvers with arguments, and nested ones', async () => {
    await using app = await createTestApp()
    const findByBooks = spyOn(app.get(ReviewRepository), 'findByBooks')
    const findByAuthors = spyOn(app.get(BookRepository), 'findByAuthors')

    const res = await executeOperation(app, {
      query: '{ books { items { reviews(first: 1) { rating } author { books { title } } } } }',
    })

    expect(res.errors).toBeUndefined()
    expect(findByBooks).toHaveBeenCalledTimes(1)
    expect(findByAuthors).toHaveBeenCalledTimes(1)
  })
})
