import { TestBed } from '@znight/testing'
import { CLOCK } from '@znight-examples/shared'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { SortableIdGenerator } from '../src/ids/sortable-id.generator.js'
import { describe, expect, test as it } from 'bun:test'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The millisecond timestamp stored in the first 48 bits of a UUIDv7. */
const timeOf = (id: string): number => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)

// TestBed builds SortableIdGenerator with its generated factory and auto-mocks its dependencies:
// here the Clock, an interface of the shared library (CLOCK is its typed runtime key).
describe('SortableIdGenerator', () => {
  it('generates UUIDv7 carrying the creation time', async () => {
    const { instance, mocks } = await TestBed.create(SortableIdGenerator, { metadata })
    mocks.get(CLOCK).now.mockReturnValue(new Date('2026-01-01T00:00:00.000Z'))

    const id = instance.next()

    expect(id).toMatch(UUID_V7)
    expect(timeOf(id)).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
  })

  it('ids sort by creation time, also within one millisecond', async () => {
    const { instance, mocks } = await TestBed.create(SortableIdGenerator, { metadata })
    const clock = mocks.get(CLOCK)
    clock.now.mockReturnValue(new Date('2026-01-01T00:00:01.000Z'))
    const sameMillisecond = Array.from({ length: 5000 }, () => instance.next()) // overflows the 12-bit counter
    clock.now.mockReturnValue(new Date('2026-01-01T00:00:00.000Z')) // the clock goes backwards
    const later = instance.next()

    const ids = [...sameMillisecond, later]
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
