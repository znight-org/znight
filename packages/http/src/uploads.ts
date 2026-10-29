/**
 * File uploads: options of `@UploadedFile` / `@UploadedFiles`, the plugin-wide limits, the
 * `uploads` helpers used by generated `invoke` functions, and the body plan of a route (body limit
 * and multipart policy).
 */
import type { HttpContext } from './context.ts'
import type { HttpRouteDefinition, HttpUploadDefinition } from './metadata.ts'
import type { FileRule, MultipartPolicy } from './multipart.ts'
import type { ByteSize } from './size.ts'

import { BadRequestException, issue } from './exceptions.ts'

/** Options of `@UploadedFile` (static: evaluated at build time). */
export interface UploadedFileOptions {
  /**
   * Answer 400 when no file is sent. Default: `true`, unless the parameter is optional
   * (`file?: File`, `File | undefined`).
   */
  readonly required?: boolean
  /** Maximum size of the file (`5_000_000`, `'5mb'`; `kb` = 1024 bytes). Default: plugin `uploads.maxFileSize`. */
  readonly maxSize?: ByteSize
  /**
   * Accepted media types, as declared by the client: `'image/png'`, `'image/*'`, `'*\/*'`. Other
   * types answer 415. Default: any.
   */
  readonly mimeTypes?: readonly string[]
}

/** Options of `@UploadedFiles` (static: evaluated at build time). */
export interface UploadedFilesOptions extends UploadedFileOptions {
  /** Maximum number of files (413 above). Default: plugin `uploads.maxFiles`. */
  readonly maxFiles?: number
}

/** Plugin-wide upload limits (`HttpPlugin.configure({ uploads })`). */
export interface UploadLimits {
  /** Default maximum size of one file (`maxSize` of upload parameters). Default: `'10mb'`. */
  readonly maxFileSize?: ByteSize
  /** Default maximum number of files of `@UploadedFiles` (and of multipart bodies of other routes). Default: `10`. */
  readonly maxFiles?: number
  /** Maximum number of parts (text fields and files) of a multipart body (413 above). Default: `1000`. */
  readonly maxParts?: number
  /** Maximum size of one text field of a multipart body (413 above). Default: `'1mb'`. */
  readonly maxFieldSize?: ByteSize
}

/** {@link UploadLimits} with defaults applied, in bytes. */
export interface ResolvedUploadLimits {
  readonly maxFileSize: number
  readonly maxFiles: number
  readonly maxParts: number
  readonly maxFieldSize: number
}

/** Default upload limits. */
export const DEFAULT_UPLOAD_LIMITS: ResolvedUploadLimits = Object.freeze({
  maxFileSize: 10 * 1024 * 1024,
  maxFiles: 10,
  maxParts: 1000,
  maxFieldSize: 1024 * 1024,
})

/** How the body of a route is read (internal). */
export interface BodyPlan {
  /** Maximum body size in bytes (`Infinity`: no limit). */
  readonly limit: number
  /** Rules applied to `multipart/form-data` bodies. */
  readonly multipart: MultipartPolicy
  /** The route declares upload parameters: non-multipart bodies answer 415. */
  readonly upload: boolean
}

/**
 * The body plan of a route: `@BodyLimit` (`route.bodyLimit`) or, for upload routes, the sum of the
 * file limits plus the plugin `bodyLimit` (room for text fields and multipart framing), else the
 * plugin `bodyLimit`.
 */
export function bodyPlan(
  route: Pick<HttpRouteDefinition, 'bodyLimit' | 'uploads'>,
  bodyLimit: number,
  limits: ResolvedUploadLimits,
): BodyPlan {
  const definitions = route.uploads ?? []
  const upload = definitions.length > 0
  const rules: FileRule[] = upload
    ? definitions.map(definition => fileRule(definition, limits))
    : [
        {
          field: undefined,
          multiple: true,
          maxSize: limits.maxFileSize,
          maxFiles: limits.maxFiles,
          mimeTypes: undefined,
        },
      ]
  let limit = route.bodyLimit
  if (limit === undefined) {
    limit = bodyLimit
    if (upload) for (const rule of rules) limit += rule.maxSize * rule.maxFiles
  }
  return { limit, upload, multipart: { rules, maxParts: limits.maxParts, maxFieldSize: limits.maxFieldSize } }
}

function fileRule(definition: HttpUploadDefinition, limits: ResolvedUploadLimits): FileRule {
  const multiple = definition.multiple === true
  return {
    field: definition.field,
    multiple,
    maxSize: definition.maxSize ?? limits.maxFileSize,
    maxFiles: multiple ? (definition.maxFiles ?? limits.maxFiles) : 1,
    mimeTypes: definition.mimeTypes,
  }
}

// -------------------------------------------------------------------------------------------------
// Helpers of the generated code
// -------------------------------------------------------------------------------------------------

/**
 * Reads uploaded files from the context (`ctx.files`) in generated `invoke` functions
 * (`@UploadedFile('avatar') avatar: File` → `uploads.file(ctx, 'avatar')`). `field` `undefined`
 * means any field. Limits were enforced while the body was read; these helpers check presence.
 */
export interface Uploads {
  /** The file of `field`; 400 `Missing file "field"` when absent. */
  file(ctx: HttpContext, field: string | undefined): File
  /** The file of `field`, `undefined` when absent. */
  optionalFile(ctx: HttpContext, field: string | undefined): File | undefined
  /** The files of `field` (at least one); 400 `Missing files "field"` when none. */
  files(ctx: HttpContext, field: string | undefined): File[]
  /** The files of `field`, possibly none. */
  optionalFiles(ctx: HttpContext, field: string | undefined): File[]
}

const NO_FILES: readonly File[] = Object.freeze([])

function filesOf(ctx: HttpContext, field: string | undefined): readonly File[] {
  const files = ctx.files
  if (field !== undefined) return Object.hasOwn(files, field) ? (files[field] ?? NO_FILES) : NO_FILES
  const all: File[] = []
  for (const name of Object.keys(files)) all.push(...(files[name] ?? NO_FILES))
  return all
}

function missing(ctx: HttpContext, field: string | undefined, multiple: boolean): BadRequestException {
  const what = multiple ? 'files' : 'file'
  if (field === undefined) return new BadRequestException(`Missing ${what}`)
  const body = ctx.body
  if (body !== null && typeof body === 'object' && Object.hasOwn(body, field)) {
    return new BadRequestException(
      `Expected a file in field ${JSON.stringify(field)}, received a text value`,
      issue(field, 'Expected a file, received a text value'),
    )
  }
  return new BadRequestException(`Missing ${what} ${JSON.stringify(field)}`, issue(field, `Missing ${what}`))
}

/** The helpers of the generated code (`import { uploads } from '@znight/http'`). */
export const uploads: Uploads = Object.freeze({
  file(ctx: HttpContext, field: string | undefined): File {
    const [file] = filesOf(ctx, field)
    if (file === undefined) throw missing(ctx, field, false)
    return file
  },
  optionalFile(ctx: HttpContext, field: string | undefined): File | undefined {
    return filesOf(ctx, field)[0]
  },
  files(ctx: HttpContext, field: string | undefined): File[] {
    const files = filesOf(ctx, field)
    if (files.length === 0) throw missing(ctx, field, true)
    return [...files]
  },
  optionalFiles(ctx: HttpContext, field: string | undefined): File[] {
    return [...filesOf(ctx, field)]
  },
})
