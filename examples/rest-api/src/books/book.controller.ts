import type { Lazy } from '@znight/core'
import type { RequestUser } from '../auth/request-user.js'
import type { Book, BookSort, Page } from './book.js'
import type { BookService } from './book.service.js'

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpResponse,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptor,
} from '@znight/http'

import { Public, Roles } from '../auth/auth.decorators.js'
import { ServerTimingInterceptor } from '../shared/server-timing.interceptor.js'
import { CreateBook, UpdateBook } from './book.schemas.js'
import { COVER_TYPES, coverExtension } from './image-type.js'

/** Largest page of `GET /books`. */
export const MAX_PAGE_SIZE = 100

/** A book as sent to clients: the cover is a link, never inline bytes. */
export interface BookResponse extends Omit<Book, 'coverUpdatedAt'> {
  readonly coverUrl: string | null
}

function toResponse({ coverUpdatedAt, ...book }: Book): BookResponse {
  return { ...book, coverUrl: coverUpdatedAt === null ? null : `/books/${book.id}/cover` }
}

/**
 * The books resource. A singleton: it is created once at boot, and the compiler generated one
 * `invoke` function per route that extracts, coerces and validates the arguments.
 *
 * - `@Roles(['reader'])` on the class applies to every route, `@Roles(['admin'])` on a route wins;
 *   `@Public()` opts a route out of authentication. The global `AuthGuard` enforces them.
 * - `@UseInterceptor` wraps every route of the controller (after the guards).
 */
@Controller('/books')
@Roles(['reader'])
@UseInterceptor(ServerTimingInterceptor)
export class BookController {
  constructor(
    private readonly books: BookService,
    private readonly user: Lazy<RequestUser>,
  ) {}

  /**
   * GET /books?q=dune&tag=classic&tag=fantasy&sort=year&limit=10&offset=0
   *
   * Query parameters are coerced to the declared types: `limit=abc` answers 400, `tag` accepts one or
   * several values, `sort` must be one of the `BookSort` literals. Default values make them optional.
   */
  @Get()
  async list(
    @Query('q') search?: string,
    @Query('author') author?: string,
    @Query('tag') tags: string[] = [],
    @Query('sort') sort: BookSort = 'title',
    @Query('limit') limit = 20,
    @Query('offset') offset = 0,
  ): Promise<Page<BookResponse>> {
    // TypeScript has no integer type: coercion gives a number, ranges are checked here
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new BadRequestException(`Invalid query "limit": expected an integer between 1 and ${MAX_PAGE_SIZE}`)
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new BadRequestException('Invalid query "offset": expected a non-negative integer')
    }
    const page = await this.books.list({ search, author, tags, sort, limit, offset })
    return { ...page, items: page.items.map(toResponse) }
  }

  /** GET /books/42: `:id` is coerced to a number (`/books/abc` answers 400). */
  @Get('/:id')
  async get(@Param('id') id: number): Promise<BookResponse> {
    return toResponse(await this.books.get(id))
  }

  /** POST /books: the body is validated by `CreateBook`; 201 with a `location` header. */
  @Post()
  @Roles(['admin'])
  async create(@Body(CreateBook) input: CreateBook): Promise<HttpResponse> {
    const book = await this.books.add(input, this.user.get().principal.name)
    return HttpResponse.created(toResponse(book), `/books/${book.id}`)
  }

  /** PATCH /books/42: partial update. */
  @Patch('/:id')
  @Roles(['admin'])
  async update(@Param('id') id: number, @Body(UpdateBook) changes: UpdateBook): Promise<BookResponse> {
    return toResponse(await this.books.update(id, changes))
  }

  /** DELETE /books/42: no return value, so the response is `204 No Content`. */
  @Delete('/:id')
  @Roles(['admin'])
  async remove(@Param('id') id: number): Promise<void> {
    await this.books.remove(id)
  }

  /**
   * PUT /books/42/cover, a `multipart/form-data` body with a `cover` file field.
   *
   * The limits are enforced while the body is read: a file above 2 MiB answers 413 and a declared
   * type outside `COVER_TYPES` answers 415, before the rest of the body is even received.
   */
  @Put('/:id/cover')
  @Roles(['admin'])
  async uploadCover(
    @Param('id') id: number,
    @UploadedFile('cover', { maxSize: '2mb', mimeTypes: COVER_TYPES }) cover: File,
  ): Promise<BookResponse> {
    await this.books.setCover(id, cover)
    return toResponse(await this.books.get(id))
  }

  /**
   * GET /books/42/cover: public, so that `<img src>` works without API key.
   *
   * `HttpResponse.file()` sends the image with `content-length`, `last-modified` and an `etag`, and
   * answers conditional (`if-none-match` → 304) and range requests (→ 206) by itself.
   */
  @Get('/:id/cover')
  @Public()
  async downloadCover(@Param('id') id: number): Promise<HttpResponse> {
    const cover = await this.books.getCover(id)
    const file = new File([cover.data.slice()], `book-${id}${coverExtension(cover.contentType)}`, {
      type: cover.contentType,
      lastModified: cover.updatedAt.getTime(),
    })
    return HttpResponse.file(file, { disposition: 'inline' })
      .withHeader('cache-control', 'public, max-age=300')
      .withHeader('x-content-type-options', 'nosniff')
  }
}
