import type { Note } from '../notes/note.js'
import type { NoteService } from '../notes/note.service.js'

import { Controller, Get, Header } from '@znight/http'

import { Roles } from '../auth/access.js'

/** A full export, for the export client. */
export interface NotesExport {
  readonly exportedAt: Date
  readonly notes: readonly Note[]
}

/** `@Roles(['admin'])` on the controller: the decision of its routes, unless a route has its own. */
@Controller('/admin')
@Roles(['admin'])
export class AdminController {
  constructor(private readonly notes: NoteService) {}

  /** GET /admin/notes: every note of every user. */
  @Get('/notes')
  all(): Promise<Note[]> {
    return this.notes.all()
  }

  /**
   * GET /admin/export: also open to the export client, a machine authenticated with an API key
   * (`x-api-key`) that holds the exporter role only: it cannot read `/admin/notes`.
   */
  @Get('/export')
  @Roles(['admin', 'exporter'])
  @Header('content-disposition', 'attachment; filename="notes.json"')
  async export(): Promise<NotesExport> {
    return { exportedAt: new Date(), notes: await this.notes.all() }
  }
}
