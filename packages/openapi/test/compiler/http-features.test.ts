/** Interplay with RFC 0006 (cookies, Server-Sent Events) and with the RFC 0001 route decisions. */
import { buildOpenApiDocument } from '../../src/index.ts'
import { cleanupApps, compileApp, loadApp, render, tempApp, validateDocument } from '../support/apps.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

describe('cookies, Server-Sent Events and route decision groups', () => {
  it('documents cookie parameters, event streams and decisions of a required group', async () => {
    const app = tempApp({
      'src/main.ts': "import { OpenApiPlugin } from '@znight/openapi'\nexport const plugin = OpenApiPlugin\n",
      'src/access.ts': `import { createRouteDecorator } from '@znight/http'
export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
`,
      'src/api.ts': `import { OpenApiDocument, securityScheme } from '@znight/openapi'
import { Public } from './access.ts'
export const Session = securityScheme('session', { type: 'apiKey', in: 'cookie', name: 'sid' })
@OpenApiDocument({ security: [Session], decisions: [{ when: Public, security: [] }] })
export class Api {}
`,
      'src/clock.controller.ts': `import { Controller, Cookie, Get, Sse, type SseEvent } from '@znight/http'
import { Authenticated, Public } from './access.ts'

export interface Tick { readonly now: string }

@Controller('/clock')
@Authenticated()
export class ClockController {
  /** Ticks */
  @Sse('/ticks')
  @Public()
  ticks(): AsyncIterable<SseEvent<Tick>> {
    return null!
  }

  /** Preferences */
  @Get('/prefs')
  prefs(@Cookie('theme') theme?: 'light' | 'dark'): { theme: string } {
    return { theme: theme ?? 'light' }
  }
}
`,
    })
    const compiled = await compileApp(app)
    expect(
      render(
        app,
        compiled.diagnostics.filter(diagnostic => diagnostic.code.startsWith('ZNIGHT03')),
      ),
    ).toEqual([])
    const { document } = await buildOpenApiDocument(await loadApp(app))
    expect(await validateDocument(document)).toMatchObject({ valid: true })
    expect(document.paths?.['/clock/ticks']?.get).toMatchObject({
      operationId: 'clock.ticks',
      security: [],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'text/event-stream': {
              schema: { type: 'string' },
              'x-znight-event-schema': { $ref: '#/components/schemas/Tick' },
            },
          },
        },
      },
    })
    expect(document.paths?.['/clock/prefs']?.get?.parameters).toEqual([
      { name: 'theme', in: 'cookie', schema: { type: 'string', enum: ['dark', 'light'] } },
    ])
    expect(document.paths?.['/clock/prefs']?.get?.security).toBeUndefined()
    expect(document.components?.securitySchemes).toEqual({ session: { type: 'apiKey', in: 'cookie', name: 'sid' } })
  })
})
