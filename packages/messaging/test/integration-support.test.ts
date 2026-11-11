/** The retry of `startContainer()` (integration test support), without Docker. */
import { startContainer } from './integration/support.ts'
import { describe, expect, it } from 'bun:test'

const RYUK_RACE = new Error('(HTTP code 404) no such container - No such image: testcontainers/ryuk:0.14.0')

describe('startContainer', () => {
  it('retries the Ryuk image race, then returns the started container', async () => {
    let calls = 0
    const started = await startContainer(
      () => {
        calls++
        return calls < 3 ? Promise.reject(RYUK_RACE) : Promise.resolve('container')
      },
      3,
      1,
    )
    expect(started).toBe('container')
    expect(calls).toBe(3)
  })

  it('gives up after the last attempt', async () => {
    let calls = 0
    const failing = startContainer(
      () => {
        calls++
        return Promise.reject(RYUK_RACE)
      },
      2,
      1,
    )
    await expect(failing).rejects.toBe(RYUK_RACE)
    expect(calls).toBe(2)
  })

  it('does not retry any other error', async () => {
    let calls = 0
    const other = new Error('No such image: rabbitmq:4.1-alpine')
    const failing = startContainer(
      () => {
        calls++
        return Promise.reject(other)
      },
      3,
      1,
    )
    await expect(failing).rejects.toBe(other)
    expect(calls).toBe(1)
  })
})
