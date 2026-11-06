import type { ChannelMember } from '../src/rooms.ts'

import { RoomRegistry } from '../src/rooms.ts'
import { describe, expect, it } from 'bun:test'

interface Fake extends ChannelMember {
  readonly frames: (string | Uint8Array)[]
  closed: number | undefined
}

function member(id: string): Fake {
  const frames: (string | Uint8Array)[] = []
  const fake: Fake = {
    id,
    roomSet: new Set(),
    frames,
    closed: undefined,
    sendFrame: frame => frames.push(frame),
    close: code => {
      fake.closed = code ?? 1000
    },
  }
  return fake
}

interface Events {
  ping: { n: number }
}

function setup() {
  const registry = new RoomRegistry<Fake>()
  const [a, b, c] = [member('a'), member('b'), member('c')]
  for (const m of [a, b, c]) registry.add(m)
  registry.join(a, 'lobby')
  registry.join(b, 'lobby')
  registry.join(b, 'vip')
  registry.join(c, 'vip')
  return { registry, a, b, c }
}

describe('rooms', () => {
  it('creates rooms on join and deletes them when empty', () => {
    const { registry, a, b } = setup()
    expect(registry.rooms()).toEqual(
      new Map([
        ['lobby', 2],
        ['vip', 2],
      ]),
    )
    registry.leave(a, 'lobby')
    registry.remove(b)
    expect(registry.rooms()).toEqual(new Map([['vip', 1]]))
    expect(b.roomSet.size).toBe(0)
    expect(registry.size).toBe(2)
  })

  it('broadcasts an encoded frame once per member of the union of rooms', () => {
    const { registry, a, b, c } = setup()
    registry.select<Events>(['lobby', 'vip']).emit('ping', { n: 1 })
    for (const m of [a, b, c]) expect(m.frames).toEqual(['{"event":"ping","data":{"n":1}}'])
  })

  it('excludes members and rooms', () => {
    const { registry, a, b, c } = setup()
    registry.select().except(a).send('x')
    registry.select('vip').except('c').send('y')
    registry.select().exceptRoom('lobby').send('z')
    expect(a.frames).toEqual([])
    expect(b.frames).toEqual(['x', 'y'])
    expect(c.frames).toEqual(['x', 'z'])
  })

  it('makes a selection join, leave and close', () => {
    const { registry, a, b, c } = setup()
    registry.select('vip').join('lobby')
    expect([...registry.room('lobby')].map(m => m.id).sort()).toEqual(['a', 'b', 'c'])
    registry.select('lobby').leave('vip')
    expect(registry.rooms().has('vip')).toBe(false)
    registry.select('lobby').except(a).close(4000)
    expect([a.closed, b.closed, c.closed]).toEqual([undefined, 4000, 4000])
  })

  it('ignores joins of unknown members', () => {
    const registry = new RoomRegistry<Fake>()
    registry.join(member('ghost'), 'lobby')
    expect(registry.rooms().size).toBe(0)
  })
})
