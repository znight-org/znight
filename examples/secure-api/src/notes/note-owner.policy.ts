import type { Lazy } from '@znight/core'
import type { CurrentUser } from '../auth/current-user.js'
import type { NoteRepository } from './note.repository.js'

import { Injectable } from '@znight/core'
import { type CanActivate, type HttpContext, NotFoundException } from '@znight/http'

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

/** The note of the `:id` parameter belongs to the caller (admins read every note, and change none). */
@Injectable()
export class NoteOwnerPolicy implements CanActivate {
  constructor(
    private readonly notes: NoteRepository,
    private readonly user: Lazy<CurrentUser>,
  ) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    const id = ctx.params.id ?? ''
    const note = await this.notes.find(id)
    const { principal } = this.user.get()
    const isAdmin = principal.roles.includes('admin')
    if (note === undefined || (note.ownerId !== principal.id && !isAdmin)) {
      // 404, not 403: do not tell other users that the note exists
      throw new NotFoundException(`Note ${id} not found`)
    }
    return note.ownerId === principal.id || READ_METHODS.has(ctx.method) // false → 403
  }
}
