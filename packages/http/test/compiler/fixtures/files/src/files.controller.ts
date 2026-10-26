// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import type { HttpContext } from '@znight/http'

import {
  Body,
  BodyLimit,
  Controller,
  Ctx,
  Get,
  HttpResponse,
  Param,
  Post,
  Put,
  UploadedFile,
  UploadedFiles,
} from '@znight/http'
import { z } from 'zod'

import { DOCUMENTS_DIR } from './storage.ts'

export const AvatarMeta = z.object({ title: z.string().min(1) })
export type AvatarMeta = z.output<typeof AvatarMeta>
export const MAX_AVATAR = '1kb'

@Controller('/files')
export class FilesController {
  @Post('/avatar')
  async avatar(
    @UploadedFile('avatar', { maxSize: MAX_AVATAR, mimeTypes: ['image/*'] }) avatar: File,
    @Body(AvatarMeta) meta: AvatarMeta,
  ) {
    return { name: avatar.name, type: avatar.type, size: avatar.size, title: meta.title }
  }

  @Post('/documents')
  @BodyLimit('64kb')
  async documents(
    @UploadedFiles('documents', { maxFiles: 2, mimeTypes: ['text/*'] }) documents: File[],
    @UploadedFile('cover') cover?: File,
  ) {
    return { documents: await Promise.all(documents.map(document => document.text())), cover: cover?.name ?? null }
  }

  @Get('/download/*')
  download(@Param('*') path: string) {
    return HttpResponse.file(path, { root: DOCUMENTS_DIR })
  }

  @Get('/export.csv')
  export() {
    async function* rows() {
      yield 'a,b\n'
      yield '1,2\n'
    }
    return HttpResponse.stream(rows(), { filename: 'export.csv' })
  }

  @Put('/raw/:name')
  @BodyLimit('1mb')
  async raw(@Param('name') name: string, @Ctx() ctx: HttpContext) {
    let size = 0
    for await (const chunk of ctx.bodyStream()) size += chunk.byteLength
    return { name, size }
  }
}
