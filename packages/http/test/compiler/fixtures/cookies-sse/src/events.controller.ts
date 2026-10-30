// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import type { HttpContext, SseEvent } from '@znight/http'

import { Body, Controller, Ctx, Headers, HttpResponse, NotFoundException, Param, Post, Sse } from '@znight/http'
import { z } from 'zod'

import { OrderHub } from './order-hub.ts'

export const Prompt = z.object({ text: z.string() })

@Controller('/orders')
export class OrderEventsController {
  constructor(private readonly hub: OrderHub) {}

  @Sse('/:id/events', { retry: 5_000, maxDuration: 30 * 60_000 })
  async events(
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Ctx() ctx: HttpContext,
  ): Promise<AsyncIterable<SseEvent<{ status: string }>> | HttpResponse> {
    await Promise.resolve()
    if (id === 'missing') throw new NotFoundException(`Order ${id} not found`)
    if (id === 'closed') return HttpResponse.noContent()
    return this.hub.subscribe(lastEventId, ctx.signal)
  }

  @Sse('/clock', { heartbeat: false })
  async *clock(@Ctx() ctx: HttpContext): AsyncGenerator<SseEvent<{ n: number }>> {
    let n = 0
    while (!ctx.signal.aborted && n < 3) {
      n++
      yield { event: 'tick', data: { n } }
      await Promise.resolve()
    }
  }

  @Post('/assistant')
  assistant(@Body(Prompt) prompt: z.output<typeof Prompt>) {
    return HttpResponse.sse(prompt.text.split(' ').map(token => ({ event: 'token', data: token })))
  }
}
