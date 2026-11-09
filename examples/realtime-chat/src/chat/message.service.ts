import type { Principal } from '../auth/request-user.js'
import type { ChatMessage, SendMessage } from './chat.protocol.js'

import { Injectable } from '@znight/core'

const HISTORY = 50

/** Rooms whose history is kept: posting to one more drops the least recently active room. */
export const MAX_HISTORY_ROOMS = 1000

/** The last messages of each room, in memory, for the most recently active rooms. */
@Injectable()
export class MessageService {
  /** In activity order: the least recently active room first. */
  readonly #rooms = new Map<string, ChatMessage[]>()
  #sequence = 0

  /** Number of rooms with a history. */
  get roomCount(): number {
    return this.#rooms.size
  }

  post(author: Principal, input: SendMessage): ChatMessage {
    const message: ChatMessage = {
      id: `m-${++this.#sequence}`,
      room: input.room,
      author: author.name,
      text: input.text,
      at: new Date().toISOString(),
    }
    const history = this.#rooms.get(input.room) ?? []
    history.push(message)
    if (history.length > HISTORY) history.shift()
    this.#rooms.delete(input.room) // re-inserted last: the most recently active room
    this.#rooms.set(input.room, history)
    if (this.#rooms.size > MAX_HISTORY_ROOMS) {
      const oldest = this.#rooms.keys().next()
      if (oldest.done !== true) this.#rooms.delete(oldest.value)
    }
    return message
  }

  history(room: string): readonly ChatMessage[] {
    return this.#rooms.get(room) ?? []
  }
}
