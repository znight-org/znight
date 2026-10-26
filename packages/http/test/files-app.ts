/**
 * A sample application for file uploads, downloads and streamed responses, described with
 * hand-written metadata shaped like the compiler output (`invoke` functions use the `uploads` /
 * `validate` helpers like the generated code). Shared by the adapter matrix, the streaming tests and
 * the Node.js / Bun runtime check.
 */
import type { ZnightMetadata } from '@znight/core'
import type { HttpContext, HttpPluginOptions } from '../src/index.ts'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'

import { HttpResponse, uploads, validate } from '../src/index.ts'
import { controller, metadata, provider, route, t } from './helpers.ts'

// -------------------------------------------------------------------------------------------------
// Files on disk
// -------------------------------------------------------------------------------------------------

/** A temporary directory with the files served by the download routes. */
export interface FilesDir {
  readonly root: string
  /** `public/` (the `root` of `/download/public/*`). */
  readonly publicDir: string
  /** 300 bytes: `0123456789` repeated. */
  readonly sample: string
  readonly sampleBytes: Uint8Array
  cleanup(): void
}

export function createFilesDir(): FilesDir {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-files-')))
  const publicDir = path.join(root, 'public')
  fs.mkdirSync(path.join(publicDir, 'docs'), { recursive: true })
  const sampleBytes = new TextEncoder().encode('0123456789'.repeat(30))
  const sample = path.join(publicDir, 'sample.txt')
  fs.writeFileSync(sample, sampleBytes)
  fs.writeFileSync(path.join(publicDir, 'docs', 'readme.md'), '# readme\n')
  fs.writeFileSync(path.join(publicDir, 'image.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(publicDir, 'empty.bin'), new Uint8Array(0))
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret')
  // a link escaping the public directory
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(publicDir, 'escape.txt'))
  const mtime = new Date('2024-05-06T07:08:09Z')
  fs.utimesSync(sample, mtime, mtime)
  return {
    root,
    publicDir,
    sample,
    sampleBytes,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

// -------------------------------------------------------------------------------------------------
// Uploads
// -------------------------------------------------------------------------------------------------

export const AvatarMeta = z.object({ title: z.string().min(1), tags: z.array(z.string()).default([]) })

/** What the upload routes answer for a file. */
export async function describeFile(file: File): Promise<{ name: string; type: string; size: number; text: string }> {
  return { name: file.name, type: file.type, size: file.size, text: await file.text() }
}

export class UploadController {
  async avatar(avatar: File, meta: z.output<typeof AvatarMeta>) {
    return { avatar: await describeFile(avatar), meta }
  }
  async optional(file: File | undefined, fields: unknown) {
    return { file: file === undefined ? null : await describeFile(file), fields }
  }
  async many(documents: File[]) {
    return { documents: await Promise.all(documents.map(describeFile)) }
  }
  async anyField(files: File[]) {
    return { files: await Promise.all(files.map(describeFile)) }
  }
  single(file: File) {
    return describeFile(file)
  }
  /** Streams the raw body (`ctx.bodyStream()`) and reports its size and a checksum. */
  async raw(ctx: HttpContext) {
    let size = 0
    let sum = 0
    for await (const chunk of ctx.bodyStream()) {
      size += chunk.byteLength
      for (const byte of chunk) sum = (sum + byte) % 65_521
    }
    return { size, sum }
  }
}

const upload = controller(t('UploadController'), '/upload', [
  route(
    'avatar',
    '/avatar',
    async (c: UploadController, ctx) =>
      c.avatar(uploads.file(ctx, 'avatar'), await validate(AvatarMeta, ctx.body, 'body')),
    {
      method: 'POST',
      params: [
        { index: 0, source: 'file', name: 'avatar' },
        { index: 1, source: 'body', schema: true },
      ],
      uploads: [{ field: 'avatar', required: true, maxSize: 64, mimeTypes: ['image/png', 'image/*'] }],
    },
  ),
  route(
    'optional',
    '/optional',
    (c: UploadController, ctx) => c.optional(uploads.optionalFile(ctx, 'file'), ctx.body),
    {
      method: 'POST',
      params: [
        { index: 0, source: 'file', name: 'file', optional: true },
        { index: 1, source: 'body' },
      ],
      uploads: [{ field: 'file' }],
    },
  ),
  route('many', '/many', (c: UploadController, ctx) => c.many(uploads.files(ctx, 'documents')), {
    method: 'POST',
    params: [{ index: 0, source: 'files', name: 'documents' }],
    uploads: [{ field: 'documents', multiple: true, required: true, maxFiles: 2, maxSize: 32 }],
  }),
  route('anyField', '/any', (c: UploadController, ctx) => c.anyField(uploads.optionalFiles(ctx, undefined)), {
    method: 'PUT',
    params: [{ index: 0, source: 'files', optional: true }],
    uploads: [{ multiple: true }],
  }),
  route('single', '/single', (c: UploadController, ctx) => c.single(uploads.file(ctx, undefined)), {
    method: 'PATCH',
    params: [{ index: 0, source: 'file' }],
    uploads: [{ required: true }],
  }),
  route('raw', '/raw', (c: UploadController, ctx) => c.raw(ctx), {
    method: 'PUT',
    params: [{ index: 0, source: 'context' }],
    bodyLimit: 100_000,
  }),
])

// -------------------------------------------------------------------------------------------------
// Downloads and streams
// -------------------------------------------------------------------------------------------------

/** Set by the tests: where the download routes read files. */
export const filesState: { dir: FilesDir | undefined } = { dir: undefined }

function dir(): FilesDir {
  if (filesState.dir === undefined) throw new Error('filesState.dir is not set')
  return filesState.dir
}

export class DownloadController {
  public(ctx: HttpContext) {
    return HttpResponse.file(ctx.params['*'] ?? '', { root: dir().publicDir })
  }
  attachment() {
    return HttpResponse.file(dir().sample, { filename: 'rapport été "final".txt' })
  }
  inline() {
    return HttpResponse.file(new URL(`file://${dir().sample}`), { disposition: 'inline' })
  }
  typed() {
    return HttpResponse.file(dir().sample, { contentType: 'text/x-custom', disposition: 'attachment' }).withHeader(
      'cache-control',
      'max-age=60',
    )
  }
  unsafe(name: string) {
    // no root: the path is used as given (documentation example of what not to do)
    return HttpResponse.file(path.join(dir().publicDir, name))
  }
  blob() {
    return HttpResponse.file(new File(['{"ok":true}'], 'data.json', { type: 'application/json', lastModified: 0 }), {
      filename: 'données.json',
    })
  }
  direct() {
    return new File(['direct file'], 'direct.txt', { type: 'text/plain' })
  }
  readable() {
    return HttpResponse.stream(Readable.from(['node ', 'readable']), { contentType: 'text/plain; charset=utf-8' })
  }
  web() {
    return HttpResponse.stream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('web ')
          controller.enqueue('stream')
          controller.close()
        },
      }),
    )
  }
  iterable() {
    async function* lines() {
      yield 'id,name\n'
      for (let index = 1; index <= 3; index++) {
        await new Promise(resolve => setTimeout(resolve, 1))
        yield new TextEncoder().encode(`${index},item ${index}\n`)
      }
    }
    return HttpResponse.stream(lines(), { filename: 'export.csv' })
  }
  failing() {
    async function* broken() {
      yield await Promise.resolve('partial')
      throw new Error('stream failure')
    }
    return HttpResponse.stream(broken())
  }
}

const download = controller(t('DownloadController'), '/download', [
  route('public', '/public/*', (c: DownloadController, ctx) => c.public(ctx), {
    params: [{ index: 0, source: 'context' }],
  }),
  route('attachment', '/attachment', (c: DownloadController) => c.attachment()),
  route('inline', '/inline', (c: DownloadController) => c.inline()),
  route('typed', '/typed', (c: DownloadController) => c.typed()),
  route('unsafe', '/unsafe/:name', (c: DownloadController, ctx) => c.unsafe(ctx.params['name'] ?? ''), {
    params: [{ index: 0, source: 'param', name: 'name', type: 'string' }],
  }),
  route('blob', '/blob', (c: DownloadController) => c.blob()),
  route('direct', '/direct', (c: DownloadController) => c.direct()),
  route('readable', '/stream/readable', (c: DownloadController) => c.readable()),
  route('web', '/stream/web', (c: DownloadController) => c.web()),
  route('iterable', '/stream/iterable', (c: DownloadController) => c.iterable()),
  route('failing', '/stream/failing', (c: DownloadController) => c.failing()),
])

// -------------------------------------------------------------------------------------------------
// Streams and request scopes
// -------------------------------------------------------------------------------------------------

/** Events of the request-scoped stream routes, in order. */
export const streamLog: string[] = []
/** Producers of `/scoped/endless`: how many chunks were pulled, and whether the producer was cancelled. */
export const endless: { pulled: number; cancelled: boolean; disposedAt: number | undefined } = {
  pulled: 0,
  cancelled: false,
  disposedAt: undefined,
}

export class StreamState {
  readonly id: number
  disposed = false
  static count = 0
  constructor() {
    this.id = ++StreamState.count
  }
  [Symbol.dispose](): void {
    this.disposed = true
    streamLog.push(`dispose ${this.id}`)
    if (endless.disposedAt === undefined && streamLog.includes(`endless ${this.id}`)) {
      endless.disposedAt = endless.pulled
    }
  }
}

/** Size of the chunks of `/scoped/endless`. */
export const ENDLESS_CHUNK = 64 * 1024

export class ScopedStreamController {
  readonly #state: StreamState
  constructor(state: StreamState) {
    this.#state = state
  }
  chunks() {
    const state = this.#state
    async function* produce() {
      try {
        for (let index = 0; index < 3; index++) {
          await new Promise(resolve => setTimeout(resolve, 5))
          streamLog.push(`chunk ${index} ${state.id} ${state.disposed ? 'disposed' : 'alive'}`)
          yield `${index}:${state.disposed ? 'disposed' : 'alive'};`
        }
      } finally {
        streamLog.push(`end ${state.id}`)
      }
    }
    return HttpResponse.stream(produce())
  }
  endless() {
    const state = this.#state
    streamLog.push(`endless ${state.id}`)
    const chunk = new Uint8Array(ENDLESS_CHUNK).fill(120)
    return HttpResponse.stream(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            endless.pulled++
            controller.enqueue(chunk.slice())
          },
          cancel() {
            endless.cancelled = true
            streamLog.push(`cancel ${state.id}`)
          },
        },
        { highWaterMark: 0 },
      ),
    )
  }
}

const scoped = controller(t('ScopedStreamController'), '/scoped', [
  route('chunks', '/chunks', (c: ScopedStreamController) => c.chunks()),
  route('endless', '/endless', (c: ScopedStreamController) => c.endless()),
])

// -------------------------------------------------------------------------------------------------
// Metadata
// -------------------------------------------------------------------------------------------------

export function filesMetadata(): ZnightMetadata {
  return metadata(
    {
      [t('UploadController')]: provider(UploadController),
      [t('DownloadController')]: provider(DownloadController),
      [t('StreamState')]: provider(StreamState, [], 'request'),
      [t('ScopedStreamController')]: provider(ScopedStreamController, [t('StreamState')], 'request'),
    },
    [upload, download, scoped],
  )
}

/** Plugin options of the files application. */
export function filesOptions(): HttpPluginOptions {
  return { bodyLimit: 2048, uploads: { maxFileSize: 1024, maxFiles: 3, maxParts: 20, maxFieldSize: 256 } }
}
