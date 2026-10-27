// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import type { SseEvent } from '@znight/http'

import { Injectable } from '@znight/core'
import { EventChannel } from '@znight/http'

@Injectable()
export class OrderHub {
  readonly #subscribers = new Set<EventChannel<SseEvent<{ status: string }>>>()
  readonly #history = [{ id: 1, status: 'created' }]

  subscribe(after: string | undefined, signal: AbortSignal): EventChannel<SseEvent<{ status: string }>> {
    const channel = new EventChannel<SseEvent<{ status: string }>>({ capacity: 16, overflow: 'close', signal })
    this.#subscribers.add(channel)
    channel.onClose(() => this.#subscribers.delete(channel))
    for (const entry of this.#history) {
      if (after === undefined || entry.id > Number(after)) channel.push({ id: entry.id, event: 'status', data: { status: entry.status } })
    }
    return channel
  }

  publish(status: string): void {
    const entry = { id: this.#history.length + 1, status }
    this.#history.push(entry)
    for (const channel of this.#subscribers) channel.push({ id: entry.id, event: 'status', data: { status } })
  }
}
