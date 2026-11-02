/**
 * The route decorator readers exported by `@znight/http/compiler` for other extensions (RFC 0003
 * §6.4, RFC 0005 H3): `readRouteMeta`, `effectiveRouteMeta` and `requiredRouteGroups`, used by a
 * fixture extension whose gateways carry route decorators, next to the http extension.
 */
import type { CompilerExtension, Diagnostic } from '@znight/compiler'
import type { MetaEntry, RequiredRouteGroup } from '../../src/compiler/index.ts'
import type { HttpAnalysis } from './helpers.ts'

import path from 'node:path'

import http, { effectiveRouteMeta, readRouteMeta, requiredRouteGroups } from '../../src/compiler/index.ts'
import { analyzeApp, cleanupApps, httpDiagnostics, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const ACCESS = `
import { createRouteDecorator } from '@znight/http'

export type Role = 'admin' | 'reader'

const OPTIONS = { group: 'access', required: true } as const

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', OPTIONS)
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
export const RateLimit = createRouteDecorator<number>('rateLimit')
`

/** A fake transport package: `@Gateway()` on classes, `@OnMessage()` on methods. */
const WS_PACKAGE: Record<string, string> = {
  'node_modules/@acme/ws/package.json': JSON.stringify({
    name: '@acme/ws',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
  }),
  'node_modules/@acme/ws/index.d.ts':
    'export declare function Gateway(): ClassDecorator\nexport declare function OnMessage(): MethodDecorator\n',
  'node_modules/@acme/ws/index.js': 'export const Gateway = () => () => {}\nexport const OnMessage = () => () => {}\n',
}

/** What the fixture extension stores per gateway. */
interface GatewayData {
  readonly name: string
  readonly meta: readonly MetaEntry[]
  readonly handlers: readonly {
    readonly name: string
    readonly own: readonly MetaEntry[]
    readonly effective: readonly MetaEntry[]
  }[]
}

/** A fixture extension reading route decorators on gateways, and the required groups in `validate`. */
function wsExtension(seen: { required?: readonly RequiredRouteGroup[] }): CompilerExtension<GatewayData> {
  return {
    apiVersion: 1,
    name: 'ws',
    decorators: {
      '@acme/ws#Gateway': { targets: ['class'], params: [] },
      '@acme/ws#OnMessage': { targets: ['method'], params: [] },
    },
    analyzeClass(cls, ctx) {
      const meta = readRouteMeta(ctx, cls)
      const handlers = cls.methods
        .filter(method => method.decorators.some(decorator => decorator.identity === '@acme/ws#OnMessage'))
        .map(method => {
          const own = readRouteMeta(ctx, cls, method)
          return { name: method.name, own, effective: effectiveRouteMeta(meta, own) }
        })
      ctx.store({ name: cls.displayName, meta, handlers })
    },
    validate(ctx) {
      const required = requiredRouteGroups(
        ctx,
        ctx.stored.flatMap(gateway => [...gateway.meta, ...gateway.handlers.flatMap(handler => handler.own)]),
      )
      seen.required = required
      for (const gateway of ctx.stored) {
        for (const handler of gateway.handlers) {
          for (const group of required) {
            if (handler.effective.some(entry => entry.group === group.group)) continue
            ctx.report({
              code: 'ZNIGHT023',
              severity: 'error',
              message: `${gateway.name}.${handler.name} has no "${group.group}" decision`,
              location: undefined,
              hints: [`Add ${group.suggestion} to the handler or to ${gateway.name}`],
            })
          }
        }
      }
    },
  }
}

interface WsAnalysis extends HttpAnalysis {
  readonly gateways: readonly GatewayData[]
  readonly required: readonly RequiredRouteGroup[] | undefined
}

async function analyzeWs(files: Record<string, string>): Promise<WsAnalysis> {
  const seen: { required?: readonly RequiredRouteGroup[] } = {}
  const app = tempApp({ ...WS_PACKAGE, ...files })
  const result = await analyzeApp(app.root, {
    extensions: [http as unknown as CompilerExtension, wsExtension(seen) as unknown as CompilerExtension],
  })
  const gateways = (result.graph.extensions.find(extension => extension.name === 'ws')?.stored ?? []) as GatewayData[]
  return { ...result, gateways, required: seen.required }
}

/** `key=value` of entries (values as JSON). */
function entries(meta: readonly MetaEntry[]): string[] {
  return meta.map(
    entry => `${entry.key}=${JSON.stringify(entry.value)} (${entry.group}${entry.required ? ', required' : ''})`,
  )
}

function at(result: HttpAnalysis, diagnostic: Diagnostic): string {
  const location = diagnostic.location
  return location === undefined ? '-' : `${path.relative(result.root, location.file)}:${location.line}`
}

const GATEWAY = `
import { Gateway, OnMessage } from '@acme/ws'
import { Authenticated, Public, RateLimit, Roles } from './auth/access.ts'

@Gateway()
@Authenticated()
@RateLimit(100)
export class ChatGateway {
  @OnMessage()
  @Public()
  ping() {}

  @OnMessage()
  @Roles(['admin'])
  @RateLimit(5)
  remove() {}

  @OnMessage()
  send() {}
}
`

describe('readRouteMeta and effectiveRouteMeta', () => {
  it('read route decorators on the classes and methods of another extension', async () => {
    const result = await analyzeWs({ 'src/auth/access.ts': ACCESS, 'src/chat.gateway.ts': GATEWAY })
    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    const [gateway] = result.gateways
    expect(entries(gateway?.meta ?? [])).toEqual(['authenticated=true (access, required)', 'rateLimit=100 (rateLimit)'])
    const handlers = Object.fromEntries(
      (gateway?.handlers ?? []).map(handler => [handler.name, [entries(handler.own), entries(handler.effective)]]),
    )
    expect(handlers).toEqual({
      ping: [['public=true (access, required)'], ['rateLimit=100 (rateLimit)', 'public=true (access, required)']],
      remove: [
        ['roles=["admin"] (access, required)', 'rateLimit=5 (rateLimit)'],
        ['roles=["admin"] (access, required)', 'rateLimit=5 (rateLimit)'],
      ],
      send: [[], ['authenticated=true (access, required)', 'rateLimit=100 (rateLimit)']],
    })
    const remove = gateway?.handlers.find(handler => handler.name === 'remove')?.own[0]
    expect(remove?.decorator).toBe('Roles')
    expect(remove?.identity).toBe('src/auth/access.ts#Roles')
    expect(path.relative(result.root, remove?.location.file ?? '')).toBe('src/chat.gateway.ts')
  })

  it('reports the problems of route decorators like the http extension (ZNIGHT005)', async () => {
    const result = await analyzeWs({
      'src/auth/access.ts': ACCESS,
      'src/chat.gateway.ts': `
import { Gateway, OnMessage } from '@acme/ws'
import { Public, RateLimit, Roles } from './auth/access.ts'

@Gateway()
@Public()
export class ChatGateway {
  @OnMessage()
  @Public()
  @Roles(['admin'])
  both() {}

  @OnMessage()
  @RateLimit
  uncalled() {}
}
`,
    })
    expect(httpDiagnostics(result)).toEqual([
      'error ZNIGHT005 src/chat.gateway.ts:10:3 @Roles sets the "access" decision of ChatGateway.both, already set by @Public on the same target',
      'error ZNIGHT005 src/chat.gateway.ts:14:3 @RateLimit must be called: @RateLimit()',
    ])
  })

  it('keep the class entries when the method decides nothing', () => {
    const classMeta = [{ group: 'access' }, { group: 'limit' }] as unknown as MetaEntry[]
    const effective = effectiveRouteMeta(classMeta, [])
    expect(effective).toEqual(classMeta)
    expect(effective).not.toBe(classMeta)
  })
})

describe('requiredRouteGroups', () => {
  it('returns the required groups with their decorators in source order', async () => {
    const result = await analyzeWs({ 'src/auth/access.ts': ACCESS, 'src/chat.gateway.ts': GATEWAY })
    expect(
      result.required?.map(group => ({
        group: group.group,
        suggestion: group.suggestion,
        decorators: group.decorators.map(member => `${member.name} ${member.key} ${member.required}`),
        at: at(result, { location: group.decorators[0]?.definition } as Diagnostic),
      })),
    ).toEqual([
      {
        group: 'access',
        suggestion: '@Public(), @Authenticated() or @Roles(...)',
        decorators: ['Public public true', 'Authenticated authenticated true', 'Roles roles true'],
        at: 'src/auth/access.ts:8',
      },
    ])
    expect(Object.isFrozen(result.required?.[0])).toBe(true)
  })

  it('knows the groups applied nowhere, and lets the caller report ZNIGHT023 like the http extension', async () => {
    const result = await analyzeWs({
      'src/auth/access.ts': ACCESS,
      'src/chat.gateway.ts': `
import { Gateway, OnMessage } from '@acme/ws'

@Gateway()
export class ChatGateway {
  @OnMessage()
  send() {}
}
`,
    })
    expect(result.required?.map(group => group.suggestion)).toEqual(['@Public(), @Authenticated() or @Roles(...)'])
    expect(
      result.diagnostics
        .filter(diagnostic => diagnostic.code === 'ZNIGHT023')
        .map(diagnostic => [diagnostic.message, ...(diagnostic.hints ?? [])]),
    ).toEqual([
      [
        'ChatGateway.send has no "access" decision',
        'Add @Public(), @Authenticated() or @Roles(...) to the handler or to ChatGateway',
      ],
    ])
  })

  it('is empty without required group', async () => {
    const result = await analyzeWs({
      'src/limits.ts': `import { createRouteDecorator } from '@znight/http'
export const RateLimit = createRouteDecorator<number>('rateLimit')
`,
      'src/chat.gateway.ts': `
import { Gateway, OnMessage } from '@acme/ws'
import { RateLimit } from './limits.ts'

@Gateway()
export class ChatGateway {
  @OnMessage()
  @RateLimit(3)
  send() {}
}
`,
    })
    expect(result.required).toEqual([])
    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
  })

  it('leaves inconsistent definitions out, reported once by the http extension (ZNIGHT005)', async () => {
    const result = await analyzeWs({
      'src/auth/access.ts': ACCESS,
      'src/auth/other.ts': `import { createRouteDecorator } from '@znight/http'
export const Open = createRouteDecorator('public', { group: 'visibility' })
`,
      'src/chat.gateway.ts': GATEWAY,
    })
    const conflicts = result.diagnostics.filter(
      diagnostic => diagnostic.code === 'ZNIGHT005' && diagnostic.message.includes('defines the key "public"'),
    )
    expect(conflicts.map(diagnostic => diagnostic.message)).toEqual([
      'The route decorator Open defines the key "public" with group "visibility", but Public defines it with group "access", required',
    ])
    // the second definition (by identity) is ignored
    expect(result.required?.map(group => group.suggestion)).toEqual(['@Public(), @Authenticated() or @Roles(...)'])
  })
})
