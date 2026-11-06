import { decodeTick, PriceFeed } from '../src/ticker/price-feed.js'
import { createApp } from './support/app.js'
import { describe, expect, test as it } from 'bun:test'

describe('/ticker/:symbol (raw)', () => {
  it('streams binary ticks to anyone', async () => {
    await using app = await createApp()
    app.get(PriceFeed).intervalMs = 5
    await using client = await app.connect('/ticker/ACME')
    const first = await client.nextRaw()
    const second = await client.nextRaw()
    expect(first).toBeInstanceOf(Uint8Array)
    expect(decodeTick(first as Uint8Array).sequence).toBe(1)
    expect(decodeTick(second as Uint8Array).sequence).toBe(2)
  })

  it('closes with 4404 for an unknown symbol', async () => {
    await using app = await createApp()
    const client = await app.connect('/ticker/NOPE')
    expect(await client.closed).toEqual({ code: 4404, reason: 'Unknown symbol NOPE' })
  })
})
