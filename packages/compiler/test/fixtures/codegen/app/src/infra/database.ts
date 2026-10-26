import { events } from '../events.js'

export class Database {
  readonly url: string
  closed = false

  constructor(url: string) {
    this.url = url
  }

  close(): void {
    this.closed = true
    events.push('Database.close')
  }
}
