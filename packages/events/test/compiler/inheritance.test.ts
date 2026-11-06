/**
 * Listeners of abstract classes (RFC 0011 §5.4): inherited through `extends` only (never
 * `implements`), the most-derived declaration of a method wins, the inheriting providers are roots
 * (`prune`, `reportUnused`) and the generated `invoke` is typed with the provider class.
 */
import type { ZnightMetadata } from '@znight/core'

import { silentLogger } from '@znight/core'
import { TestApp } from '@znight/testing'

import { EventPublisher, EventsPlugin } from '../../src/index.ts'
import { analyzeFiles, cleanupApps, compileAndLoad, compileApp, render, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const EVENTS = `export abstract class UserEvent {
  constructor(readonly userId: string) {}
}
export class UserCreated extends UserEvent {
  createdOnly(): string {
    return 'created'
  }
}
export class UserDeleted extends UserEvent {}
`

const LOG = `export const log: string[] = []
`

/** `order token method eventName detached` per generated listener. */
function listenersOf(metadata: ZnightMetadata): string[] {
  const section = (metadata.extensions as Record<string, { listeners: Record<string, unknown>[] }>)['events']
  return (section?.listeners ?? []).map(
    l => `${l['order']} ${l['token']} ${l['method']} ${l['eventName']} ${l['detached']}`,
  )
}

describe('roots', () => {
  it('keeps a provider that only inherits listeners with prune and reportUnused', async () => {
    const app = tempApp({
      'src/events.ts': EVENTS,
      'src/n.ts': `import { Injectable } from '@znight/core'
import { OnEvent } from '@znight/events'
import { UserCreated } from './events.ts'

export abstract class Notifier {
  @OnEvent()
  on(_event: UserCreated): void {}
}

@Injectable()
export class MailNotifier extends Notifier {}
`,
    })
    const result = await compileApp(app.root, { prune: true, reportUnused: true })
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    expect(result.code).toContain("['events']")
    expect(result.code).toContain("'src/n.ts#MailNotifier'")
  })
})

describe('overrides', () => {
  it('lets the most-derived declaration of a method win', async () => {
    const app = tempApp({
      'src/log.ts': LOG,
      'src/events.ts': EVENTS,
      'src/base.ts': `import { OnEvent } from '@znight/events'
import { UserEvent } from './events.ts'
import { log } from './log.ts'

export abstract class UserHandler {
  @OnEvent()
  handle(event: UserEvent): void {
    log.push(\`base:\${this.constructor.name}:\${event.constructor.name}\`)
  }
}

export abstract class Middle extends UserHandler {
  override handle(_event: UserEvent): void {}
}
`,
      'src/handlers.ts': `import { Injectable } from '@znight/core'
import { OnEvent } from '@znight/events'
import { Middle, UserHandler } from './base.ts'
import { UserCreated, UserEvent } from './events.ts'
import { log } from './log.ts'

@Injectable()
export class CreatedHandler extends UserHandler {
  @OnEvent({ detached: true })
  override handle(event: UserCreated): void {
    log.push(\`created:\${event.createdOnly()}\`)
  }
}

@Injectable()
export class SameEvent extends UserHandler {
  @OnEvent({ detached: true, order: 5 })
  override handle(event: UserEvent): void {
    log.push(\`same:\${event.constructor.name}\`)
  }
}

@Injectable()
export class Silent extends UserHandler {
  override handle(_event: UserEvent): void {
    log.push('silent')
  }
}

@Injectable()
export class Plain extends UserHandler {}

@Injectable()
export class BelowMiddle extends Middle {}
`,
    })
    const { metadata } = await compileAndLoad(app)
    expect(listenersOf(metadata)).toEqual([
      '0 src/handlers.ts#CreatedHandler handle UserCreated true',
      '0 src/handlers.ts#Plain handle UserEvent false',
      '5 src/handlers.ts#SameEvent handle UserEvent true',
    ])
    const { log } = (await import(app.path('src/log.ts'))) as { log: string[] }
    const events = (await import(app.path('src/events.ts'))) as {
      UserCreated: new (id: string) => object
      UserDeleted: new (id: string) => object
    }
    const plugin = EventsPlugin.configure()
    await using test = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    const publisher = test.app.container.get(EventPublisher)
    await publisher.publish(new events.UserDeleted('u1'))
    await plugin.idle()
    expect(log.sort()).toEqual(['base:Plain:UserDeleted', 'same:UserDeleted'])
    log.length = 0
    await publisher.publish(new events.UserCreated('u2'))
    await plugin.idle()
    expect(log.sort()).toEqual(['base:Plain:UserCreated', 'created:created', 'same:UserCreated'])
  })
})

describe('extends, not implements', () => {
  it('does not run the listeners of an abstract class on a provider implementing it', async () => {
    const app = tempApp({
      'src/events.ts': EVENTS,
      'src/n.ts': `import { Injectable } from '@znight/core'
import { OnEvent } from '@znight/events'
import { UserCreated } from './events.ts'

export abstract class Notifier {
  @OnEvent()
  on(_event: UserCreated): void {}
}

@Injectable()
export class FakeNotifier implements Notifier {
  on(_event: UserCreated): void {}
}
`,
    })
    const result = await compileApp(app.root)
    expect(result.code).not.toContain("['events']")
    expect(
      render({ root: app.root, diagnostics: result.diagnostics }, ['ZNIGHT070']).map(l => l.split('\n')[0]),
    ).toEqual([
      'warning ZNIGHT070 src/n.ts:6:3 Notifier.on() never runs: no provider extends the abstract class Notifier',
    ])
  })

  it('keeps a union member that implements another member', async () => {
    const result = await analyzeFiles({
      'src/n.ts': `import { OnEvent } from '@znight/events'

export class LegacyEvent {}
export class Imported implements LegacyEvent {}

export class Handler {
  @OnEvent()
  handle(_event: Imported | LegacyEvent): void {}
}
`,
    })
    expect(render(result, ['ZNIGHT070'])).toEqual([])
    expect(result.listeners.map(listener => listener.event.name)).toEqual(['Imported', 'LegacyEvent'])
  })
})

describe('generated code', () => {
  it('types the inherited invoke with the provider class (a private abstract base compiles)', async () => {
    const app = tempApp({
      'src/events.ts': EVENTS,
      'src/x.ts': `import { Injectable } from '@znight/core'
import { OnEvent } from '@znight/events'
import { UserCreated } from './events.ts'

abstract class Base {
  @OnEvent()
  on(_event: UserCreated): void {}
}

@Injectable()
export class Sub extends Base {}
`,
    })
    const { result, metadata } = await compileAndLoad(app)
    expect(listenersOf(metadata)).toEqual(['0 src/x.ts#Sub on UserCreated false'])
    expect(result.code).toMatch(/\(c: Sub, e: UserCreated\) => c\.on\(e\)/)
  })
})
