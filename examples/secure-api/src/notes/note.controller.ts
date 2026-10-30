import type { Lazy } from '@znight/core'
import type { CurrentUser } from '../auth/current-user.js'
import type { NoteService } from './note.service.js'

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpResponse,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuard,
} from '@znight/http'

import { Authenticated, Roles } from '../auth/access.js'
import { RateLimit } from '../security/rate-limit.js'
import { type Note, NoteInput } from './note.js'
import { NoteOwnerPolicy } from './note-owner.policy.js'

/**
 * Personal notes. Every route needs an authenticated caller (the controller's decision), creating
 * one needs the editor role (the route's own decision replaces the controller's), and the routes of
 * one note run `NoteOwnerPolicy` after the global guards.
 */
@Controller('/notes')
@Authenticated()
export class NoteController {
  constructor(
    private readonly notes: NoteService,
    private readonly user: Lazy<CurrentUser>,
  ) {}

  /** GET /notes: the notes of the caller. */
  @Get()
  list(): Promise<Note[]> {
    return this.notes.listOwnedBy(this.user.get().principal.id)
  }

  /** POST /notes: 201 with a `location`; 403 without the editor role, 429 above 30 per minute. */
  @Post()
  @Roles(['editor'])
  @RateLimit({ points: 30, duration: 60 })
  async create(@Body(NoteInput) input: NoteInput): Promise<HttpResponse<Note>> {
    const note = await this.notes.create(this.user.get().principal.id, input)
    return HttpResponse.created(note, `/notes/${note.id}`)
  }

  /** GET /notes/:id: the owner, or an administrator; 404 for anyone else. */
  @Get('/:id')
  @UseGuard(NoteOwnerPolicy)
  async get(@Param('id') id: string): Promise<Note> {
    return found(id, await this.notes.find(id))
  }

  /** PATCH /notes/:id: the owner only (an administrator gets 403). */
  @Patch('/:id')
  @UseGuard(NoteOwnerPolicy)
  async update(@Param('id') id: string, @Body(NoteInput) input: NoteInput): Promise<Note> {
    return found(id, await this.notes.update(id, input))
  }

  /** DELETE /notes/:id: the owner only; 204. */
  @Delete('/:id')
  @UseGuard(NoteOwnerPolicy)
  remove(@Param('id') id: string): Promise<void> {
    return this.notes.remove(id)
  }
}

/** The policy found the note; it may have been deleted since by a concurrent request. */
function found(id: string, note: Note | undefined): Note {
  if (note === undefined) throw new NotFoundException(`Note ${id} not found`)
  return note
}
