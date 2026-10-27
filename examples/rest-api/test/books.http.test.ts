import type { TestApp } from '@znight/testing'
import type { BookResponse } from '../src/books/book.controller.js'

import { Logger, MetricsRegistry } from '@znight/observability'
import { createMock } from '@znight/testing'

import { createTestApp } from './support/app.js'
import { ADMIN_KEY, BROWSER_ORIGIN, PNG_BYTES, pngFile, READER_KEY } from './support/fixtures.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

/**
 * HTTP-level tests: the real application (controllers, guard, interceptor, exception mapper,
 * service, Drizzle repository, PGlite database), requests sent in memory with `app.inject()`.
 * Each test creates its own books (unique ISBNs), so they share one application.
 */
describe('Books API', () => {
  let app: TestApp
  let isbnSequence = 0

  /** A valid, unique ISBN-13 (the check digit is not verified by the schema). */
  const nextIsbn = (): string => `978000000${String(++isbnSequence).padStart(4, '0')}`

  async function createBook(fields: Record<string, unknown> = {}): Promise<BookResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/books',
      headers: admin,
      body: { isbn: nextIsbn(), title: 'Dune', author: 'Frank Herbert', publishedYear: 1965, ...fields },
    })
    expect(response.status).toBe(201)
    return response.json<BookResponse>()
  }

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  describe('authentication', () => {
    it('requires an API key', async () => {
      const response = await app.inject({ url: '/books' })

      expect(response.status).toBe(401)
      expect(response.headers['www-authenticate']).toBe('ApiKey header="x-api-key"')
      expect(response.json()).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Missing API key (x-api-key header)',
      })
    })

    it('exposes the caller through the request-scoped RequestUser', async () => {
      const me = await app.inject({ url: '/me', headers: reader })

      expect(me.json()).toEqual({ name: 'reader', roles: ['reader'] })
    })

    it('requires an API key on @Authenticated routes', async () => {
      const response = await app.inject({ url: '/me' })

      expect(response.status).toBe(401)
      expect(response.headers['www-authenticate']).toBe('ApiKey header="x-api-key"')
    })

    it('enforces @Roles: the read-only key cannot write', async () => {
      const response = await app.inject({ method: 'DELETE', url: '/books/1', headers: reader })

      expect(response.status).toBe(403)
    })

    it('serves @Public routes without API key', async () => {
      const response = await app.inject({ url: '/health' })

      expect(response.status).toBe(200)
      expect(response.json()).toMatchObject({ status: 'ok' })
    })
  })

  describe('CRUD', () => {
    it('creates a book (201 + location) on behalf of the caller', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/books',
        headers: admin,
        body: { isbn: '978-0-441-17271-9', title: '  Dune ', author: 'Frank Herbert', tags: ['Classic'] },
      })

      expect(response.status).toBe(201)
      const book = response.json<BookResponse>()
      // the handler received the schema output: trimmed, normalised
      expect(book).toMatchObject({ isbn: '9780441172719', title: 'Dune', tags: ['classic'], createdBy: 'admin' })
      expect(response.headers.location).toBe(`/books/${book.id}`)
      // set by ServerTimingInterceptor
      expect(response.headers['server-timing']).toMatch(/^handler;dur=/)
    })

    it('validates the body with the zod schema', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/books',
        headers: admin,
        body: { isbn: '123', title: '', publishedYear: 1965.5 },
      })

      expect(response.status).toBe(400)
      expect(response.json<{ details: { path: string }[] }>().details.map(issue => issue.path)).toEqual([
        'isbn',
        'title',
        'author',
        'publishedYear',
      ])
    })

    it('maps a duplicate ISBN to 409', async () => {
      const book = await createBook()

      const response = await app.inject({
        method: 'POST',
        url: '/books',
        headers: admin,
        body: { isbn: book.isbn, title: 'Another', author: 'Someone' },
      })

      expect(response.status).toBe(409)
      expect(response.json()).toMatchObject({ error: 'Conflict', details: { isbn: book.isbn } })
    })

    it('reads, updates and deletes a book', async () => {
      const book = await createBook()

      const read = await app.inject({ url: `/books/${book.id}`, headers: reader })
      expect(read.json()).toEqual(book)

      const updated = await app.inject({
        method: 'PATCH',
        url: `/books/${book.id}`,
        headers: admin,
        body: { title: 'Dune Messiah' },
      })
      expect(updated.status).toBe(200)
      expect(updated.json()).toMatchObject({ id: book.id, title: 'Dune Messiah', author: 'Frank Herbert' })

      const deleted = await app.inject({ method: 'DELETE', url: `/books/${book.id}`, headers: admin })
      expect(deleted.status).toBe(204)
      expect(deleted.body).toBe('')

      // BookNotFoundError → 404 (DomainErrorMapper)
      const gone = await app.inject({ url: `/books/${book.id}`, headers: reader })
      expect(gone.status).toBe(404)
      expect(gone.json()).toEqual({ statusCode: 404, error: 'Not Found', message: `Book ${book.id} not found` })
    })

    it('coerces route parameters', async () => {
      const response = await app.inject({ url: '/books/abc', headers: reader })

      expect(response.status).toBe(400)
      expect(response.json()).toMatchObject({ message: 'Invalid param "id": expected a number, received "abc"' })
    })
  })

  describe('listing', () => {
    it('filters by tag and author, sorts and paginates', async () => {
      const author = `Author ${crypto.randomUUID()}`
      await createBook({ author, title: 'B', publishedYear: 2001, tags: ['poetry'] })
      await createBook({ author, title: 'A', publishedYear: 1999, tags: ['poetry', 'essay'] })
      await createBook({ author, title: 'C', tags: ['novel'] })

      const response = await app.inject({
        url: '/books',
        headers: reader,
        query: { author, tag: ['poetry', 'essay'], sort: 'year', limit: '1' },
      })

      expect(response.status).toBe(200)
      const page = response.json<{ items: BookResponse[]; total: number; limit: number; offset: number }>()
      expect(page).toMatchObject({ total: 2, limit: 1, offset: 0 })
      expect(page.items.map(book => book.title)).toEqual(['A'])
    })

    it('rejects invalid query parameters', async () => {
      const sort = await app.inject({ url: '/books?sort=price', headers: reader })
      expect(sort.status).toBe(400)
      expect(sort.json()).toMatchObject({ message: expect.stringContaining('query "sort"') })

      const limit = await app.inject({ url: '/books?limit=1000', headers: reader })
      expect(limit.status).toBe(400)
    })
  })

  describe('covers', () => {
    it('uploads a cover and downloads it publicly', async () => {
      const book = await createBook()
      const form = new FormData()
      form.append('cover', pngFile())

      const upload = await app.inject({ method: 'PUT', url: `/books/${book.id}/cover`, headers: admin, body: form })
      expect(upload.status).toBe(200)
      expect(upload.json()).toMatchObject({ id: book.id, coverUrl: `/books/${book.id}/cover` })

      // no API key: the route is @Public()
      const download = await app.inject({ url: `/books/${book.id}/cover` })
      expect(download.status).toBe(200)
      expect(download.headers['content-type']).toBe('image/png')
      expect(download.headers['x-content-type-options']).toBe('nosniff')
      expect(download.bytes).toEqual(PNG_BYTES)

      // conditional request: the ETag comes from the upload date and the size
      const etag = String(download.headers.etag)
      const cached = await app.inject({ url: `/books/${book.id}/cover`, headers: { 'if-none-match': etag } })
      expect(cached.status).toBe(304)
    })

    it('enforces the upload limits', async () => {
      const book = await createBook()

      const wrongType = new FormData()
      wrongType.append('cover', new File(['plain text'], 'cover.txt', { type: 'text/plain' }))
      const refused = await app.inject({
        method: 'PUT',
        url: `/books/${book.id}/cover`,
        headers: admin,
        body: wrongType,
      })
      expect(refused.status).toBe(415)

      const tooLarge = new FormData()
      tooLarge.append('cover', new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'cover.png', { type: 'image/png' }))
      const rejected = await app.inject({
        method: 'PUT',
        url: `/books/${book.id}/cover`,
        headers: admin,
        body: tooLarge,
      })
      expect(rejected.status).toBe(413)

      const missing = await app.inject({
        method: 'PUT',
        url: `/books/${book.id}/cover`,
        headers: admin,
        body: new FormData(),
      })
      expect(missing.status).toBe(400)
    })

    it('answers 404 for a book without cover', async () => {
      const book = await createBook()

      const response = await app.inject({ url: `/books/${book.id}/cover` })

      expect(response.status).toBe(404)
    })
  })

  describe('browser and proxy policies', () => {
    const fromBrowser = { origin: BROWSER_ORIGIN }

    it('answers CORS preflights before the guard (browsers send them without API key)', async () => {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/books',
        headers: {
          ...fromBrowser,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-api-key',
        },
      })

      expect(preflight.status).toBe(204)
      expect(preflight.headers['access-control-allow-origin']).toBe(BROWSER_ORIGIN)
      expect(preflight.headers['access-control-allow-headers']).toBe('x-api-key')

      const elsewhere = await app.inject({
        method: 'OPTIONS',
        url: '/books',
        headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
      })
      expect(elsewhere.status).toBe(403)
      expect(elsewhere.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('lets the allowed origin read replies, errors included', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/books',
        headers: { ...admin, ...fromBrowser },
        body: { isbn: nextIsbn(), title: 'Emma', author: 'Jane Austen' },
      })
      expect(created.status).toBe(201)
      expect(created.headers['access-control-allow-origin']).toBe(BROWSER_ORIGIN)
      expect(created.headers['access-control-expose-headers']).toBe('location, x-request-id')
      expect(created.headers.vary).toContain('origin')

      // the page can show the 401; CORS is not access control, the guard still refuses
      const anonymous = await app.inject({ url: '/books', headers: fromBrowser })
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers['access-control-allow-origin']).toBe(BROWSER_ORIGIN)
    })

    it('sends the security headers, and no-store unless the route sets its own cache-control', async () => {
      const list = await app.inject({ url: '/books', headers: reader })

      expect(list.headers['cache-control']).toBe('no-store')
      expect(list.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'")
      expect(list.headers['x-content-type-options']).toBe('nosniff')
      expect(list.headers['x-frame-options']).toBe('DENY')
      expect(list.headers['referrer-policy']).toBe('no-referrer')

      const book = await createBook()
      const form = new FormData()
      form.append('cover', pngFile())
      await app.inject({ method: 'PUT', url: `/books/${book.id}/cover`, headers: admin, body: form })
      const cover = await app.inject({ url: `/books/${book.id}/cover` })
      expect(cover.headers['cache-control']).toBe('public, max-age=300')
      expect(cover.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'")
    })
  })

  it('counts added books in Prometheus (@Metric)', async () => {
    await createBook()

    const metrics = await app.get(MetricsRegistry).metrics()

    expect(metrics).toMatch(/bookshelf_books_added_total\{[^}]*outcome="success"[^}]*\} \d+/)
  })
})

describe('behind a proxy', () => {
  /**
   * The test application trusts the loopback address (`TRUSTED_PROXIES=loopback`), where
   * `app.inject()` requests come from: the client address is read from `x-forwarded-for`.
   */
  it('logs rejected API keys with the client address, not the proxy', async () => {
    const logger = createMock<Logger>()
    await using app = await createTestApp({ overrides: [[Logger, logger]] })

    const response = await app.inject({
      url: '/books',
      headers: { 'x-api-key': 'guessed', 'x-forwarded-for': '198.51.100.20, 203.0.113.7' },
    })

    expect(response.status).toBe(401)
    // the rightmost untrusted address: a client cannot pick its address by prepending entries
    expect(logger.warn).toHaveBeenCalledWith('Invalid API key', { ip: '203.0.113.7', route: '/books' })
  })
})
