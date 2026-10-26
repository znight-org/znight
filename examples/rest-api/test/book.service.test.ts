import type { BookRepository } from '../src/books/book.repository.js'

import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { BookNotFoundError, CoverNotFoundError, UnsupportedCoverError } from '../src/books/book.js'
import { BookService } from '../src/books/book.service.js'
import { aBook, PNG_BYTES, pngFile } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

/**
 * Unit tests: TestBed builds BookService with its generated factory and replaces its direct
 * dependencies with auto-mocks. `BookRepository` is an interface: its mock is looked up by name
 * (typed with the generic), `Logger` (provided at runtime by ObservabilityPlugin) by class.
 */
async function setup() {
  const { instance, mocks } = await TestBed.create(BookService, { metadata })
  return { service: instance, repository: mocks.get<BookRepository>('BookRepository'), logger: mocks.get(Logger) }
}

describe('BookService', () => {
  it('returns a book', async () => {
    const { service, repository } = await setup()
    repository.findById.mockResolvedValue(aBook({ id: 7 }))

    expect(await service.get(7)).toMatchObject({ id: 7, title: 'The Hobbit' })
    expect(repository.findById).toHaveBeenCalledWith(7)
  })

  it('throws a domain error for an unknown book', async () => {
    const { service, repository } = await setup()
    repository.findById.mockResolvedValue(undefined)

    // the service knows nothing about HTTP: DomainErrorMapper turns this into a 404
    await expect(service.get(404)).rejects.toBeInstanceOf(BookNotFoundError)
  })

  it('adds a book on behalf of the caller', async () => {
    const { service, repository } = await setup()
    repository.create.mockResolvedValue(aBook({ id: 3, createdBy: 'admin' }))

    const book = await service.add({ isbn: '9780547928227', title: 'The Hobbit', author: 'Tolkien' }, 'admin')

    expect(book.id).toBe(3)
    expect(repository.create).toHaveBeenCalledWith(
      { isbn: '9780547928227', title: 'The Hobbit', author: 'Tolkien' },
      'admin',
    )
  })

  it('removes a book and logs it', async () => {
    const { service, repository, logger } = await setup()
    repository.delete.mockResolvedValue(true)

    await service.remove(3)

    expect(logger.info).toHaveBeenCalledWith('Book removed', { bookId: 3 })
  })

  it('refuses to remove an unknown book', async () => {
    const { service, repository } = await setup()
    repository.delete.mockResolvedValue(false)

    await expect(service.remove(3)).rejects.toBeInstanceOf(BookNotFoundError)
  })

  describe('covers', () => {
    it('stores the cover with the type detected from its content', async () => {
      const { service, repository } = await setup()
      repository.saveCover.mockResolvedValue(true)

      // the client claims JPEG, the bytes say PNG: the content wins
      await service.setCover(1, pngFile('cover.jpg', 'image/jpeg'))

      expect(repository.saveCover).toHaveBeenCalledWith(1, { contentType: 'image/png', data: PNG_BYTES })
    })

    it('rejects a file that is not an image, without storing it', async () => {
      const { service, repository } = await setup()

      const notAnImage = new File(['<svg onload="alert(1)"/>'], 'cover.png', { type: 'image/png' })

      await expect(service.setCover(1, notAnImage)).rejects.toBeInstanceOf(UnsupportedCoverError)
      expect(repository.saveCover).not.toHaveBeenCalled()
    })

    it('refuses a cover for an unknown book', async () => {
      const { service, repository } = await setup()
      repository.saveCover.mockResolvedValue(false)

      await expect(service.setCover(9, pngFile())).rejects.toBeInstanceOf(BookNotFoundError)
    })

    it('reports a missing cover', async () => {
      const { service, repository } = await setup()
      repository.findCover.mockResolvedValue(undefined)

      await expect(service.getCover(1)).rejects.toBeInstanceOf(CoverNotFoundError)
    })
  })
})
