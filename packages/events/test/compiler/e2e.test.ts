/**
 * End to end (RFC 0011 §5): an application is compiled with `compile()` (the extension discovered
 * through the manifest), then booted with `TestApp` and `EventsPlugin`: inline listeners in order and
 * in the publisher's scope, base classes and unions, detached listeners after the publication.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { silentLogger } from '@znight/core'
import { TestApp } from '@znight/testing'

import { EventPublisher, EventsPlugin } from '../../src/index.ts'
import { analyzeFiles, cleanupApps, compileAndLoad, render, TSC, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const APP: Readonly<Record<string, string>> = {
  'src/log.ts': `export const log: string[] = []
`,
  'src/events.ts': `export abstract class UserEvent {
  abstract readonly userId: string
}

export class UserCreated extends UserEvent {
  constructor(readonly userId: string) {
    super()
  }
}

export class UserDeleted extends UserEvent {
  constructor(readonly userId: string) {
    super()
  }
}

export class Unheard {}
`,
  'src/listeners.ts': `import { Injectable } from '@znight/core'
import { OnEvent } from '@znight/events'
import { UserCreated, UserDeleted, UserEvent } from './events.ts'
import { log } from './log.ts'

@Injectable({ scope: 'request' })
export class UnitOfWork {
  readonly id = Math.random()
}

export class Audit {
  @OnEvent({ order: 10 })
  any(event: UserEvent): void {
    log.push(\`audit:\${event.constructor.name}:\${event.userId}\`)
  }
}

@Injectable({ scope: 'request' })
export class Linker {
  constructor(private readonly work: UnitOfWork) {}

  @OnEvent({ order: -10 })
  async link(event: UserCreated | UserDeleted): Promise<void> {
    await Promise.resolve()
    log.push(\`link:\${event.userId}:\${this.work.id}\`)
  }
}

export class WelcomeMail {
  @OnEvent({ detached: true })
  send(event: UserCreated): void {
    log.push(\`mail:\${event.userId}\`)
  }
}
`,
  'src/users.ts': `import { Injectable } from '@znight/core'
import { EventPublisher } from '@znight/events'
import { UserCreated } from './events.ts'
import { UnitOfWork } from './listeners.ts'
import { log } from './log.ts'

@Injectable({ scope: 'request' })
export class CreateUser {
  constructor(
    private readonly events: EventPublisher,
    private readonly work: UnitOfWork,
  ) {}

  async execute(id: string): Promise<void> {
    log.push(\`work:\${this.work.id}\`)
    await this.events.publish(new UserCreated(id))
    log.push('published')
  }
}
`,
}

describe('compiled application', () => {
  it('generates the listeners sorted by order, token and method', async () => {
    const app = tempApp(APP)
    const { result, metadata } = await compileAndLoad(app)
    expect(result.code).toContain("['events']")
    const listeners = (metadata.extensions as Record<string, { listeners: Record<string, unknown>[] }>)['events']
      ?.listeners
    expect(
      listeners?.map(l => `${l['order']} ${l['token']} ${l['method']} ${l['eventName']} ${l['detached']}`),
    ).toEqual([
      '-10 src/listeners.ts#Linker link UserCreated false',
      '-10 src/listeners.ts#Linker link UserDeleted false',
      '0 src/listeners.ts#WelcomeMail send UserCreated true',
      '10 src/listeners.ts#Audit any UserEvent false',
    ])
  })

  it('the generated module type-checks with strict compiler options', async () => {
    const app = tempApp(APP)
    const { result } = await compileAndLoad(app)
    app.write(
      'tsconfig.check.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2024',
          lib: ['ES2024', 'ESNext.Disposable'],
          module: 'preserve',
          moduleResolution: 'bundler',
          customConditions: ['@znight/source'],
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noPropertyAccessFromIndexSignature: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          experimentalDecorators: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          noEmit: true,
          types: ['node'],
        },
        include: ['src'],
        files: [path.relative(app.root, result.outFile)],
      }),
    )
    const run = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.check.json', '--listFiles'], {
      cwd: app.root,
      encoding: 'utf8',
    })
    const output = `${run.stdout}${run.stderr}`
    expect(output).toContain(result.outFile)
    expect(output.split('\n').filter(line => line.startsWith('src/'))).toEqual([])
  })

  it('dispatches inline listeners in the publisher scope, then detached ones', async () => {
    const app = tempApp(APP)
    const { metadata } = await compileAndLoad(app)
    const { log } = (await import(app.path('src/log.ts'))) as { log: string[] }
    const { CreateUser } = (await import(app.path('src/users.ts'))) as { CreateUser: new () => unknown }
    const events = await import(app.path('src/events.ts'))
    const plugin = EventsPlugin.configure()
    await using test = await TestApp.create({ metadata, plugins: [plugin], logger: silentLogger })
    await test.app.container.runInScope(async () => {
      const useCase = test.app.container.get(CreateUser) as { execute(id: string): Promise<void> }
      await useCase.execute('u1')
    })
    await plugin.idle()
    const work = log[0]?.slice('work:'.length)
    expect(log).toEqual([`work:${work}`, `link:u1:${work}`, 'audit:UserCreated:u1', 'published', 'mail:u1'])
    log.length = 0
    const publisher = test.app.container.get(EventPublisher)
    await publisher.publish(new events.UserDeleted('u2'))
    expect(log.map(line => line.replace(/:0\.\d+$/, ''))).toEqual(['link:u2', 'audit:UserDeleted:u2'])
    log.length = 0
    await publisher.publish(new events.Unheard())
    expect(log).toEqual([])
    expect(() => publisher.emit({ type: 'x' })).toThrow(TypeError)
  })
})

describe('diagnostics', () => {
  it('reports invalid listeners (ZNIGHT070) and wrong targets (ZNIGHT005)', async () => {
    const result = await analyzeFiles({
      'src/bad.ts': `import { OnEvent } from '@znight/events'

export interface Shape { readonly id: string }
export class Generic<T> { constructor(readonly value: T) {} }
export class Ok {}

export class Bad {
  // @ts-expect-error a string is the NestJS form
  @OnEvent('user.created')
  named(event: Ok): void {}

  @OnEvent()
  shape(event: Shape): void {}

  @OnEvent()
  generic(event: Generic<string>): void {}

  @OnEvent()
  two(a: Ok, b: Ok): void {}

  @OnEvent({ async: true })
  nest(event: Ok): void {}

  @OnEvent()
  private hidden(event: Ok): void {}

  @OnEvent()
  nullable(event: Ok | null): void {}
}
`,
    })
    expect(render(result).map(line => line.split('\n')[0])).toMatchSnapshot()
  })

  it('reports a detached listener whose host depends on a request-scoped external', async () => {
    const result = await analyzeFiles({
      'src/bad.ts': `import { OnEvent } from '@znight/events'
import { HttpContext } from '@znight/http'

export class Ok {}

export class Mail {
  constructor(private readonly http: HttpContext) {}

  @OnEvent({ detached: true })
  send(event: Ok): void {}
}
`,
    })
    expect(render(result, ['ZNIGHT070']).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT070 src/bad.ts:9:3 Mail.send() is detached but Mail depends on HttpContext, which does not exist in a detached listener',
    ])
  })
})
