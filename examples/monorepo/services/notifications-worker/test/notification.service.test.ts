import type { NotificationChannel } from '../src/notifications/notification.js'

import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'
import { CLOCK, IdGenerator, type User, UserDirectory, type UserRegistered } from '@znight-examples/shared'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { NotificationService } from '../src/notifications/notification.service.js'
import { describe, expect, test as it } from 'bun:test'

const registered: UserRegistered = { id: 'u1', email: 'ada@example.com', name: 'Ada', at: '2026-01-01T00:00:00.000Z' }
const ada: User = {
  id: 'u1',
  email: 'ada@example.com',
  name: 'Ada',
  createdAt: registered.at,
  updatedAt: registered.at,
}

/**
 * TestBed builds the real NotificationService and auto-mocks its direct dependencies: three
 * providers of the shared library (UserDirectory by class, Clock by interface, IdGenerator by
 * abstract class), the local NotificationChannel interface and Logger.
 */
async function setUp() {
  const { instance, mocks } = await TestBed.create(NotificationService, { metadata })
  mocks.get(CLOCK).now.mockReturnValue(new Date('2026-01-02T00:00:00.000Z'))
  mocks.get(IdGenerator).next.mockReturnValue('n1')
  // an interface has no runtime value: look its mock up by name (or by its implementation class)
  const channel = mocks.get<NotificationChannel>('NotificationChannel')
  return { instance, mocks, channel, users: mocks.get(UserDirectory) }
}

describe('NotificationService', () => {
  it('welcomes a new user, then records them', async () => {
    const { instance, channel, users } = await setUp()

    const notification = await instance.welcome(registered)

    expect(notification).toEqual({
      id: 'n1',
      to: 'ada@example.com',
      template: 'welcome',
      subject: 'Welcome aboard, Ada!',
      createdAt: '2026-01-02T00:00:00.000Z',
    })
    expect(channel.send).toHaveBeenCalledWith(notification)
    expect(users.upsert).toHaveBeenCalledWith(ada)
    expect(instance.sent).toBe(1)
  })

  it('ignores a redelivered user.registered (idempotent handler)', async () => {
    const { instance, channel, users, mocks } = await setUp()
    users.find.mockReturnValue(ada)

    expect(await instance.welcome(registered)).toBeUndefined()
    expect(channel.send).not.toHaveBeenCalled()
    expect(mocks.get(Logger).info).toHaveBeenCalledWith('Duplicate user.registered ignored', { userId: 'u1' })
  })

  it('does not record the user when the channel fails (the retry sends again)', async () => {
    const { instance, channel, users } = await setUp()
    channel.send.mockRejectedValue(new Error('SMTP down'))

    await expect(instance.welcome(registered)).rejects.toThrow('SMTP down')
    expect(users.upsert).not.toHaveBeenCalled()
  })

  it('says goodbye to a known user, then forgets them', async () => {
    const { instance, channel, users } = await setUp()
    users.find.mockReturnValue(ada)

    const notification = await instance.goodbye({ id: 'u1', at: '2026-01-03T00:00:00.000Z' })

    expect(notification).toMatchObject({ to: 'ada@example.com', template: 'goodbye', subject: 'Goodbye, Ada' })
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(users.remove).toHaveBeenCalledWith('u1')
  })

  it('ignores user.deleted for an unknown user', async () => {
    const { instance, channel } = await setUp()

    expect(await instance.goodbye({ id: 'u2', at: '2026-01-03T00:00:00.000Z' })).toBeUndefined()
    expect(channel.send).not.toHaveBeenCalled()
  })
})
