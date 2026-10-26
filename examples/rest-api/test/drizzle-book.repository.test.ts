import type { TestDatabase } from './support/database.js'

import { DuplicateIsbnError, type NewBook } from '../src/books/book.js'
import { DrizzleBookRepository } from '../src/books/drizzle-book.repository.js'
import { createTestDatabase } from './support/database.js'
import { PNG_BYTES } from './support/fixtures.js'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

/**
 * The repository against a real PostgreSQL: PGlite runs in-process, so every test gets a fresh,
 * migrated database in a few milliseconds. No container is needed to build a class whose only
 * dependency is the database.
 */
describe('DrizzleBookRepository', () => {
  let database: TestDatabase
  let repository: DrizzleBookRepository

  beforeEach(async () => {
    database = await createTestDatabase()
    repository = new DrizzleBookRepository(database.db)
  })

  afterEach(async () => {
    await database.close()
  })

  const hobbit: NewBook = {
    isbn: '9780547928227',
    title: 'The Hobbit',
    author: 'J. R. R. Tolkien',
    publishedYear: 1937,
    tags: ['fantasy'],
  }
  const dune: NewBook = {
    isbn: '9780441172719',
    title: 'Dune',
    author: 'Frank Herbert',
    publishedYear: 1965,
    tags: ['science-fiction'],
  }
  const untitled: NewBook = { isbn: '9781234567897', title: '100% Pure_Text', author: 'Anonymous' }

  it('creates and reads books', async () => {
    const created = await repository.create(hobbit, 'admin')

    expect(created).toMatchObject({ ...hobbit, createdBy: 'admin', coverUpdatedAt: null })
    expect(await repository.findById(created.id)).toEqual(created)
    expect(await repository.findById(created.id + 1)).toBeUndefined()
    // ids that cannot exist never reach PostgreSQL (which would fail on an integer overflow)
    expect(await repository.findById(1.5)).toBeUndefined()
    expect(await repository.findById(2 ** 40)).toBeUndefined()
  })

  it('turns a unique violation into a domain error', async () => {
    await repository.create(hobbit, 'admin')

    await expect(repository.create({ ...dune, isbn: hobbit.isbn }, 'admin')).rejects.toBeInstanceOf(DuplicateIsbnError)
  })

  it('filters, sorts and paginates', async () => {
    await repository.create(hobbit, 'admin')
    await repository.create(dune, 'admin')
    await repository.create(untitled, 'admin')

    const byYear = await repository.list({ sort: 'year', limit: 10, offset: 0 })
    // books without year come last
    expect(byYear.items.map(book => book.title)).toEqual(['The Hobbit', 'Dune', '100% Pure_Text'])
    expect(byYear.total).toBe(3)

    const page = await repository.list({ sort: 'title', limit: 1, offset: 1 })
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 })
    expect(page.items.map(book => book.title)).toEqual(['Dune'])

    const tagged = await repository.list({ tags: ['fantasy', 'poetry'], sort: 'title', limit: 10, offset: 0 })
    expect(tagged.items.map(book => book.title)).toEqual(['The Hobbit'])

    // `%` and `_` are searched literally, not as LIKE wildcards
    const search = await repository.list({ search: '0% pure_', sort: 'title', limit: 10, offset: 0 })
    expect(search.items.map(book => book.title)).toEqual(['100% Pure_Text'])
    expect((await repository.list({ search: 'p_re', sort: 'title', limit: 10, offset: 0 })).total).toBe(0)
  })

  it('updates only the given fields', async () => {
    const created = await repository.create(hobbit, 'admin')

    const updated = await repository.update(created.id, { title: 'The Hobbit, or There and Back Again' })

    expect(updated).toMatchObject({ title: 'The Hobbit, or There and Back Again', author: hobbit.author })
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())
    expect(await repository.update(999, { title: 'x' })).toBeUndefined()
  })

  it('stores covers and deletes them with their book', async () => {
    const created = await repository.create(hobbit, 'admin')

    expect(await repository.saveCover(created.id, { contentType: 'image/png', data: PNG_BYTES })).toBe(true)
    expect(await repository.saveCover(999, { contentType: 'image/png', data: PNG_BYTES })).toBe(false)

    const cover = await repository.findCover(created.id)
    expect(cover).toMatchObject({ contentType: 'image/png', data: PNG_BYTES })
    expect((await repository.findById(created.id))?.coverUpdatedAt).toEqual(cover?.updatedAt ?? null)

    expect(await repository.delete(created.id)).toBe(true)
    expect(await repository.delete(created.id)).toBe(false)
    expect(await repository.findCover(created.id)).toBeUndefined()
  })
})
