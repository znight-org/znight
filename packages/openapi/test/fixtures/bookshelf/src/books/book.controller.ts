import type { BookResponse, BookSort, Page, ShelfReport } from './book.ts'

import {
  All,
  Body,
  Controller,
  Delete,
  type FileBody,
  Get,
  Header,
  Headers,
  HttpResponse,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
} from '@znight/http'
import { ApiExclude, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@znight/openapi'

import { Public, Roles } from '../auth/auth.decorators.ts'
import { CoverForm, CreateBook, Rating, SearchQuery } from './book.schemas.ts'

const COVER_TYPES = ['image/png', 'image/jpeg']

/** Books of the shelf. */
@Controller('/books')
@Roles(['reader'])
@ApiTags('Books')
@ApiHeader('x-tenant', { description: 'Tenant of the shelf' })
export class BookController {
  /**
   * List books
   *
   * Sorted and paginated, filtered by text and tags.
   * @param search Case-insensitive search in titles.
   * @param limit Page size.
   */
  @Get()
  @Header('cache-control', 'no-store')
  list(
    @Query('q') search?: string,
    @Query('tag') tags: string[] = [],
    @Query('sort') sort: BookSort = 'title',
    @Query('limit') limit = 20,
  ): Promise<Page<BookResponse>> {
    return Promise.resolve({ items: [], total: 0, limit, offset: 0, ...{ search, tags, sort } } as never)
  }

  /** Search with a schema */
  @Get('/search')
  @Public()
  search(@Query(SearchQuery) query: unknown): BookResponse[] {
    return query as never
  }

  /** Get a book */
  @Get('/:id')
  @ApiResponse(404, { description: 'No book with this id' })
  get(@Param('id') id: number): Promise<BookResponse> {
    return Promise.resolve({ id } as never)
  }

  /**
   * Add a book
   * @returns The new book. Its URL is in the `location` header.
   */
  @Post()
  @Roles(['admin'])
  @ApiResponse(201, { headers: { location: { description: 'URL of the new book' } } })
  @ApiResponse(409, { description: 'A book with this ISBN is already on the shelf' })
  create(@Body(CreateBook) input: CreateBook): Promise<HttpResponse<BookResponse>> {
    return Promise.resolve(HttpResponse.created({ id: 1, title: input.title } as BookResponse, '/books/1'))
  }

  /** Upload the cover */
  @Put('/:id/cover')
  @Roles(['admin'])
  uploadCover(
    @Param('id') id: number,
    @UploadedFile('cover', { maxSize: '2mb', mimeTypes: COVER_TYPES }) cover: File,
    @Body(CoverForm) form: unknown,
  ): { id: number; size: number } {
    return { id, size: cover.size + (form === undefined ? 0 : 0) }
  }

  /** Download the cover */
  @Get('/:id/cover')
  @Public()
  @ApiResponse(200, { description: 'The cover image', contentType: COVER_TYPES })
  @ApiResponse(404, { description: 'No book with this id, or no cover' })
  downloadCover(@Param('id') id: number): Promise<HttpResponse<FileBody>> {
    return Promise.resolve(HttpResponse.file(`${id}.png`))
  }

  /** Report of the shelf */
  @Get('/report')
  @ApiResponse<ShelfReport>(200)
  report(): Response {
    return new Response('{}')
  }

  /** Remove a book */
  @Delete('/:id')
  @Roles(['admin'])
  @ApiOperation({ operationId: 'removeBook', deprecated: true })
  remove(@Param('id') id: number): Promise<void> {
    return Promise.resolve(void id)
  }

  /** Rate a book */
  @Post('/:id/ratings')
  @Public()
  rate(
    @Param('id') id: number,
    @Body(Rating) rating: { stars: number },
    @Headers('x-request-source') source?: string,
  ): {
    id: number
    stars: number
  } {
    return { id, stars: rating.stars + (source === undefined ? 0 : 0) }
  }

  /** Files of a book */
  @Get('/:id/files/*')
  @ApiQuery<number>('version', { description: 'Version of the file' })
  file(@Param('id') id: number, @Param('*') path: string): string {
    return `${id}/${path}`
  }

  /** Proxy */
  @All('/:id/proxy')
  proxy(@Param('id') id: number): { id: number } {
    return { id }
  }

  @Get('/internal')
  @ApiExclude()
  internal(): string {
    return 'hidden'
  }
}
