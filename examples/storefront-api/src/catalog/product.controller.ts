import type { FileBody } from '@znight/http'
import type { Page } from '../shared/page.js'
import type { CatalogService } from './catalog.service.js'
import type { Category, ProductResponse, ProductSort, ProductSummary } from './product.js'

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpResponse,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
} from '@znight/http'
import { ApiResponse, ApiSecurity, ApiTags } from '@znight/openapi'

import { ApiKey } from '../api.js'
import { Public, Roles } from '../auth/auth.decorators.js'
import { Id } from '../shared/id.js'
import { FORBIDDEN, UNAUTHORIZED } from '../shared/responses.js'
import { IMAGE_TYPES, imageExtension } from './image.js'
import { toResponse, toSummary } from './product.js'
import { CreateProduct } from './product.schemas.js'

/** Largest page of `GET /products`. */
export const MAX_PAGE_SIZE = 100

/**
 * The catalogue: what anyone may browse, and what the back office manages.
 *
 * Everything the OpenAPI document says about these routes comes from this file: paths and
 * parameters from the route table, their types and defaults from the signatures, summaries and
 * descriptions from the JSDoc, request bodies from the Zod schemas, responses from the **annotated
 * return types**. The `@Api*` decorators only add what the code cannot say (a `404`, the API key of
 * the back-office routes). They do nothing at runtime: the compiler reads them and the build strips
 * them.
 *
 * - `@Public()` on the class is the access decision of every route without its own: the document
 *   gets `security: []` for them through the `decisions` of `@OpenApiDocument` (src/api.ts).
 * - The back-office routes replace it with `@Roles(['catalog'])` (the nearest decision wins) and
 *   declare the API key with `@ApiSecurity(ApiKey)`: the document default is the customers' bearer.
 * - `@ApiTags('Catalog')` groups the operations (without it, the tag would be `Product`).
 */
@Controller('/products')
@Public()
@ApiTags('Catalog')
export class ProductController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * List products
   *
   * The public catalogue, one page at a time.
   * @param search Case-insensitive search in names and descriptions.
   * @param category Only the products of this department.
   * @param tags Only the products carrying every one of these labels (`?tag=mug&tag=gift`).
   * @param inStock Only the products that can be ordered now.
   * @param sort Order of the results.
   * @param limit Page size, between 1 and 100.
   * @param offset Number of results to skip.
   */
  @Get()
  list(
    @Query('q') search?: string,
    @Query('category') category?: Category,
    @Query('tag') tags: string[] = [],
    @Query('inStock') inStock = false,
    @Query('sort') sort: ProductSort = 'name',
    @Query('limit') limit = 20,
    @Query('offset') offset = 0,
  ): Page<ProductSummary> {
    // query values are coerced to the declared types (`limit=abc` is a 400, `sort` must be one of
    // the `ProductSort` literals); TypeScript has no integer type, so ranges are checked here
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new BadRequestException(`Invalid query "limit": expected an integer between 1 and ${MAX_PAGE_SIZE}`)
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new BadRequestException('Invalid query "offset": expected a non-negative integer')
    }
    const page = this.catalog.list({ search, category, tags, inStock, sort, limit, offset })
    return { ...page, items: page.items.map(toSummary) }
  }

  /** Get a product */
  @Get('/:id')
  @ApiResponse(404, { description: 'No product with this id' })
  get(@Param('id', Id) id: string): ProductResponse {
    return toResponse(this.catalog.get(id))
  }

  /**
   * Add a product
   *
   * Back office: an API key with the `catalog` role. The SKU is stored in upper case, the tags in
   * lower case, and the price, sent in euros as a decimal string (`"14.90"`), in cents.
   * @param input The new product.
   * @returns The new product. Its URL is in the `location` header.
   */
  @Post()
  @Roles(['catalog'])
  @ApiSecurity(ApiKey)
  @ApiResponse(201, { headers: { location: { description: 'URL of the new product', required: true } } })
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  @ApiResponse(409, { description: 'A product with this SKU already exists' })
  create(@Body(CreateProduct) input: CreateProduct): HttpResponse<ProductResponse> {
    const product = this.catalog.create(input)
    return HttpResponse.created(toResponse(product), `/products/${product.id}`)
  }

  /**
   * Check a product
   *
   * Validates a product without adding it, and answers what `POST /products` would store: the
   * output of the `CreateProduct` schema (normalised SKU and tags, price in cents, defaults applied).
   * The request body is the schema **input** (`CreateProductInput` in the document), the response
   * its **output** (`CreateProduct`).
   */
  @Post('/validate')
  @Roles(['catalog'])
  @ApiSecurity(ApiKey)
  @HttpCode(200)
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  validate(@Body(CreateProduct) input: CreateProduct): CreateProduct {
    return input
  }

  /**
   * Upload the product image
   *
   * A `multipart/form-data` body with one `image` file field: PNG, JPEG or WebP, at most 1 MiB. The
   * declared media type is checked while the body arrives (`415`), then the content itself: a file
   * that is not really one of these images is refused too.
   */
  @Put('/:id/image')
  @Roles(['catalog'])
  @ApiSecurity(ApiKey)
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  @ApiResponse(404, { description: 'No product with this id' })
  async uploadImage(
    @Param('id', Id) id: string,
    @UploadedFile('image', { maxSize: '1mb', mimeTypes: IMAGE_TYPES }) image: File,
  ): Promise<ProductResponse> {
    return toResponse(await this.catalog.setImage(id, image))
  }

  /**
   * Download the product image
   *
   * Public and cacheable: `<img src>` works without credentials. Conditional requests
   * (`if-none-match`) answer `304`, and `range` requests `206`.
   */
  @Get('/:id/image')
  @ApiResponse(200, { description: 'The image', contentType: IMAGE_TYPES })
  // `HttpResponse.file()` chooses the status at runtime: the other answers are declared here
  @ApiResponse(206, { description: 'The part of the image asked for with `range`', contentType: IMAGE_TYPES })
  @ApiResponse(304, { description: 'The image did not change since the `etag` sent in `if-none-match`' })
  @ApiResponse(404, { description: 'No product with this id, or no image' })
  image(@Param('id', Id) id: string): HttpResponse<FileBody> {
    const image = this.catalog.getImage(id)
    // `HttpResponse.file()` sends `content-length`, `last-modified` and a strong `etag`, and handles
    // conditional and range requests by itself
    const file = new File([image.bytes.slice()], `product-${id}${imageExtension(image.contentType)}`, {
      type: image.contentType,
      lastModified: image.updatedAt.getTime(),
    })
    // the route's `cache-control` replaces the API-wide `no-store` (src/http.ts)
    return HttpResponse.file(file, { disposition: 'inline' }).withHeader('cache-control', 'public, max-age=300')
  }
}
