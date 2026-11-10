import {
  Application,
  type ErrorReportEvent,
  Hooks,
  type Plugin,
  type PluginContext,
  silentLogger,
  ZnightAggregateError,
  type ZnightError,
} from '../src/index.ts'
import { caught, classDef, meta, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

/**
 * A reporter plugin, like the Sentry recipe: it subscribes to `error:report` in `register` and
 * records its own `onDispose` in `log` (a real reporter flushes there).
 */
function reporter(reports: ErrorReportEvent[], log: string[] = []): Plugin {
  return {
    name: 'reporter',
    register(ctx: PluginContext) {
      ctx.hooks.on('error:report', report => {
        reports.push(report)
        log.push(`report ${report.operation}`)
      })
    },
    onDispose() {
      log.push('reporter.onDispose')
    },
  }
}

function failing(name: string, hook: 'onBootstrap' | 'onStart' | 'onStop', error: Error): Plugin {
  return { name, [hook]: () => Promise.reject(error) } as Plugin
}

const options = { logger: silentLogger, shutdown: { signals: false as const } }

describe('error:report hook (lifecycle)', () => {
  it('is typed on the hooks bus and emitted only to listeners', () => {
    const hooks = new Hooks({ logger: silentLogger })
    expect(hooks.hasListeners('error:report')).toBe(false)
    const seen: string[] = []
    const remove = hooks.on('error:report', report => {
      seen.push(`${report.source} ${report.operation} ${String(report.tags['phase'])}`)
    })
    expect(hooks.hasListeners('error:report')).toBe(true)
    hooks.emit('error:report', {
      error: new Error('x'),
      source: 'lifecycle',
      operation: 'Application.start()',
      requestId: undefined,
      tags: { phase: 'start' },
      context: undefined,
    })
    remove()
    expect(seen).toEqual(['lifecycle Application.start() start'])
  })

  it('reports a failed create() once, before the plugins are disposed', async () => {
    const reports: ErrorReportEvent[] = []
    const log: string[] = []
    const cause = new Error('cannot connect')
    const error = await caught(() =>
      Application.create({
        ...options,
        metadata: meta({}),
        plugins: [reporter(reports, log), failing('db', 'onBootstrap', cause)],
      }),
    )
    expect(reports).toHaveLength(1)
    const report = reports[0] as ErrorReportEvent
    expect(report.error).toBe(error)
    expect((report.error as ZnightError).cause).toBe(cause)
    expect(report.source).toBe('lifecycle')
    expect(report.operation).toBe('Application.create()')
    expect(report.tags).toEqual({ phase: 'bootstrap' })
    expect(report.requestId).toBeUndefined()
    expect(log).toEqual(['report Application.create()', 'reporter.onDispose'])
  })

  it('reports a failed start() once, with the error start() rejects with', async () => {
    class Server {
      onStart(): void {
        throw new Error('port in use')
      }
    }
    const reports: ErrorReportEvent[] = []
    const app = await Application.create({
      ...options,
      metadata: meta({ [t('Server')]: classDef(Server) }),
      plugins: [reporter(reports)],
    })
    const error = await caught(() => app.start())
    expect(reports.map(report => [report.operation, report.tags['phase']])).toEqual([['Application.start()', 'start']])
    expect(reports[0]?.error).toBe(error)
  })

  it('reports each failed shutdown step, before the reporter is disposed', async () => {
    const reports: ErrorReportEvent[] = []
    const log: string[] = []
    const cause = new Error('broker gone')
    const app = await Application.create({
      ...options,
      metadata: meta({}),
      plugins: [reporter(reports, log), failing('broker', 'onStop', cause)],
    })
    await app.start()
    const error = await caught(() => app.stop())
    expect(error).toBeInstanceOf(ZnightAggregateError)
    expect(reports).toHaveLength(1)
    const report = reports[0] as ErrorReportEvent
    expect(report.operation).toBe('Plugin "broker" onStop()')
    expect(report.tags).toEqual({ phase: 'stop' })
    expect(report.error).toBe((error as ZnightAggregateError).errors[0])
    expect((report.error as ZnightError).cause).toBe(cause)
    expect(log).toEqual(['report Plugin "broker" onStop()', 'reporter.onDispose'])
  })

  it('reports nothing for a clean lifecycle', async () => {
    const reports: ErrorReportEvent[] = []
    const app = await Application.create({ ...options, metadata: meta({}), plugins: [reporter(reports)] })
    await app.start()
    await app.stop()
    expect(reports).toEqual([])
  })
})
