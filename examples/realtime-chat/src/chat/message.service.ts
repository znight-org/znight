import type { Principal } from '../auth/request-user.js'
import type { ChatMessage, SendMessage } from './chat.protocol.js'

import { Injectable } from '@znight/core'

const HISTORY = 50

/** The last messages of each room, in memory. */
@Injectable()
export class MessageService {
  readonly #rooms = new Map<string, ChatMessage[]>()
  #sequence = 0

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
    this.#rooms.set(input.room, history)
    return message
  }

  history(room: string): readonly ChatMessage[] {
    return this.#rooms.get(room) ?? []
  }
}
