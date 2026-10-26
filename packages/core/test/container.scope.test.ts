import { Container, ErrorCode, getSuppressedErrors, ZnightAggregateError, type ZnightError } from '../src/index.ts'
import { caught, caughtSync, factoryDef, later, meta, sleep, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const HTTP_CONTEXT = '@znight/http#HttpContext'

interface Ctx {
  readonly id: string
}

class RequestState {
  static created = 0
  readonly ctx: Ctx
  readonly serial: number
  constructor(ctx: Ctx) {
    this.ctx = ctx
    this.serial = ++RequestState.created
  }
}

function create(disposed: string[] = []): Container {
  return Container.create(
    meta(
      {
        [t('Config')]: factoryDef(() => ({ env: 'test' })),
        [t('RequestState')]: {
          scope: 'request',
          class: RequestState,
          deps: [HTTP_CONTEXT],
          factory: d => new RequestState(d[0] as Ctx),
        },
        [t('Handler')]: factoryDef(
          d => ({
            state: d[0] as RequestState,
            config: d[1],
            [Symbol.dispose]: () => disposed.push(`Handler ${(d[0] as RequestState).ctx.id}`),
          }),
          [t('RequestState'), t('Config')],
          { scope: 'request' },
        ),
        [t('Disposable')]: factoryDef(
          d => ({ close: () => disposed.push(`Disposable ${(d[0] as Ctx).id}`) }),
          [HTTP_CONTEXT],
          { scope: 'request', dispose: 'close' },
        ),
      },
      { externals: [{ token: HTTP_CONTEXT, scope: 'request', providedBy: 'HttpPlugin' }] },
    ),
  )
}

describe('runInScope', () => {
  it('creates one request-scoped instance per scope', async () => {
    const container = create()
    await container.init()
    const [a1, a2] = await container.runInScope(
      () => [container.get(RequestState), container.get(RequestState)],
      [[HTTP_CONTEXT, { id: 'a' }]],
    )
    const b = await container.runInScope(() => container.get(RequestState), [[HTTP_CONTEXT, { id: 'b' }]])
    expect(a1).toBe(a2 as RequestState)
    expect(a1).not.toBe(b)
    expect(a1?.ctx.id).toBe('a')
    expect(b.ctx.id).toBe('b')
  })

  it('isolates many concurrent scopes', async () => {
    const container = create()
    await container.init()
    const ids = Array.from({ length: 200 }, (_, index) => `req-${index}`)
    const results = await Promise.all(
      ids.map(id =>
        container.runInScope(async () => {
          const before = container.get(RequestState)
          await sleep(Math.random() * 5)
          const after = container.get<{ state: RequestState }>(t('Handler')).state
          return { id, before, after, seen: container.get<Ctx>(HTTP_CONTEXT).id }
        }, [[HTTP_CONTEXT, { id }]]),
      ),
    )
    const instances = new Set<RequestState>()
    for (const result of results) {
      expect(result.before).toBe(result.after)
      expect(result.before.ctx.id).toBe(result.id)
      expect(result.seen).toBe(result.id)
      instances.add(result.before)
    }
    expect(instances.size).toBe(ids.length)
  })

  it('resolves singletons inside and outside of scopes identically', async () => {
    const container = create()
    await container.init()
    const config = container.get(t('Config'))
    const inside = await container.runInScope(
      () => container.get<{ config: unknown }>(t('Handler')).config,
      [[HTTP_CONTEXT, { id: 'x' }]],
    )
    expect(inside).toBe(config)
  })

  it('returns the value of fn, sync or async', async () => {
    const container = create()
    await container.init()
    expect(await container.runInScope(() => 42)).toBe(42)
    expect(await container.runInScope(() => later(1, 'async'))).toBe('async')
  })

  it('accepts seed values keyed by class, alias or token', async () => {
    const container = Container.create(
      meta(
        { [t('Impl')]: factoryDef(() => 'impl', [], { scope: 'request' }) },
        { aliases: { 'src/x.ts#Port': t('Impl') } },
      ),
    )
    await container.init()
    const value = await container.runInScope(() => container.get(t('Impl')), [['src/x.ts#Port', 'seeded']])
    expect(value).toBe('seeded')
  })

  it('ignores seeds for singleton bindings (the binding wins)', async () => {
    const container = create()
    await container.init()
    const config = container.get(t('Config'))
    const seen = await container.runInScope(() => container.get(t('Config')), [[t('Config'), 'seed']])
    expect(seen).toBe(config)
  })

  it('resolves unknown tokens from the scope values', async () => {
    const container = create()
    await container.init()
    const seen = await container.runInScope(
      () => [container.get('@acme/custom#Thing'), container.has('@acme/custom#Thing')],
      [['@acme/custom#Thing', 1]],
    )
    expect(seen).toEqual([1, true])
    expect(container.has('@acme/custom#Thing')).toBe(false)
  })

  it('opens a fresh scope for nested calls', async () => {
    const container = create()
    await container.init()
    const [outer, inner, outerAgain] = await container.runInScope(async () => {
      const first = container.get(RequestState)
      const nested = await container.runInScope(() => container.get(RequestState), [[HTTP_CONTEXT, { id: 'inner' }]])
      return [first, nested, container.get(RequestState)]
    }, [[HTTP_CONTEXT, { id: 'outer' }]])
    expect(outer).toBe(outerAgain as RequestState)
    expect(inner).not.toBe(outer)
    expect(inner?.ctx.id).toBe('inner')
  })
})

describe('request scope errors', () => {
  it('throws ZNIGHT013 when resolving a request-scoped provider outside of a scope', async () => {
    const container = create()
    await container.init()
    const error = caughtSync(() => container.get(RequestState)) as ZnightError
    expect(error.code).toBe(ErrorCode.NoActiveScope)
    expect(error.message).toContain('RequestState')
    expect(error.hints.join(' ')).toContain('runInScope')
  })

  it('throws ZNIGHT013 for a request-scoped external outside of a scope or absent from it', async () => {
    const container = create()
    await container.init()
    expect((caughtSync(() => container.get(HTTP_CONTEXT)) as ZnightError).code).toBe(ErrorCode.NoActiveScope)
    const error = (await caught(() => container.runInScope(() => container.get(HTTP_CONTEXT)))) as ZnightError
    expect(error.code).toBe(ErrorCode.NoActiveScope)
    expect(error.message).toContain('provided by HttpPlugin')
    expect(await container.runInScope(() => container.getOptional(HTTP_CONTEXT))).toBeUndefined()
    expect(container.has(HTTP_CONTEXT)).toBe(false)
    expect(await container.runInScope(() => container.has(HTTP_CONTEXT), [[HTTP_CONTEXT, {}]])).toBe(true)
  })

  it('reports resolution in a scope that already closed', async () => {
    const container = create()
    await container.init()
    let pending: Promise<unknown> | undefined
    await container.runInScope(() => {
      pending = sleep(5).then(() => container.get(RequestState))
    }, [[HTTP_CONTEXT, { id: 'leak' }]])
    const error = (await caught(() => pending)) as ZnightError
    expect(error.code).toBe(ErrorCode.NoActiveScope)
    expect(error.message).toContain('already closed')
  })
})

describe('scope disposal', () => {
  it('disposes instances created in the scope in reverse creation order when fn settles', async () => {
    const disposed: string[] = []
    const container = create(disposed)
    await container.init()
    await container.runInScope(() => {
      container.get(t('Disposable'))
      container.get(t('Handler'))
      expect(disposed).toEqual([])
    }, [[HTTP_CONTEXT, { id: '1' }]])
    expect(disposed).toEqual(['Handler 1', 'Disposable 1'])
  })

  it('disposes when fn rejects and rethrows the error of fn', async () => {
    const disposed: string[] = []
    const container = create(disposed)
    await container.init()
    const failure = new Error('handler failed')
    const error = await caught(() =>
      container.runInScope(async () => {
        container.get(t('Handler'))
        await sleep(1)
        throw failure
      }, [[HTTP_CONTEXT, { id: '2' }]]),
    )
    expect(error).toBe(failure)
    expect(disposed).toEqual(['Handler 2'])
  })

  it('does not dispose seed values', async () => {
    const container = create()
    await container.init()
    let disposed = false
    await container.runInScope(
      () => container.get(HTTP_CONTEXT),
      [[HTTP_CONTEXT, { id: 's', [Symbol.dispose]: () => (disposed = true) }]],
    )
    expect(disposed).toBe(false)
  })

  it('rejects with ZNIGHT021 when only the disposal fails', async () => {
    const container = Container.create(
      meta({
        [t('Bad')]: factoryDef(
          () => ({
            [Symbol.asyncDispose]: () => Promise.reject(new Error('flush failed')),
          }),
          [],
          { scope: 'request' },
        ),
      }),
    )
    await container.init()
    const error = (await caught(() => container.runInScope(() => container.get(t('Bad'))))) as ZnightAggregateError
    expect(error).toBeInstanceOf(ZnightAggregateError)
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
    expect(error.errors).toHaveLength(1)
    expect(error.message).toContain('flush failed')
  })

  it('attaches disposal errors to the error of fn', async () => {
    const container = Container.create(
      meta({
        [t('Bad')]: factoryDef(
          () => ({
            [Symbol.dispose]: () => {
              throw new Error('close failed')
            },
          }),
          [],
          { scope: 'request' },
        ),
      }),
    )
    await container.init()
    const failure = new Error('fn failed')
    const error = await caught(() =>
      container.runInScope(() => {
        container.get(t('Bad'))
        throw failure
      }),
    )
    expect(error).toBe(failure)
    expect(getSuppressedErrors(error)).toHaveLength(1)
  })
})

describe('currentScope', () => {
  it('exposes the active scope values', async () => {
    const container = create()
    await container.init()
    expect(container.currentScope()).toBeUndefined()
    await container.runInScope(() => {
      const scope = container.currentScope()
      expect(scope).toBeDefined()
      expect(scope?.get<Ctx>(HTTP_CONTEXT)?.id).toBe('c')
      expect(scope?.has(RequestState)).toBe(false)
      const state = container.get(RequestState)
      expect(scope?.get(RequestState)).toBe(state)
      expect(scope?.has('RequestState')).toBe(true)
      scope?.set(HTTP_CONTEXT, { id: 'changed' })
      expect(container.get<Ctx>(HTTP_CONTEXT).id).toBe('changed')
      expect(scope?.closed).toBe(false)
    }, [[HTTP_CONTEXT, { id: 'c' }]])
  })

  it('lets a scope value replace a request-scoped provider before it is created', async () => {
    const container = create()
    await container.init()
    const replacement = new RequestState({ id: 'manual' })
    const seen = await container.runInScope(() => {
      container.currentScope()?.set(RequestState, replacement)
      return container.get(RequestState)
    })
    expect(seen).toBe(replacement)
  })

  it('creates on-demand singletons outside of the request scope that first uses them', async () => {
    const seen: string[] = []
    const holder: { container?: Container } = {}
    const observe = (label: string): void => {
      seen.push(`${label}: ${holder.container?.currentScope() === undefined ? 'no scope' : 'scope'}`)
    }
    const container = Container.create(
      meta({
        [t('Root')]: factoryDef(() => 'root'),
        [t('Dep')]: factoryDef(() => {
          observe('dep')
          return 'dep'
        }),
        [t('Flusher')]: factoryDef(() => {
          observe('factory')
          setTimeout(() => observe('timer'), 1)
          return { flushing: true }
        }, [t('Dep')]),
      }),
    )
    holder.container = container
    await container.init({ only: [t('Root')] })
    await container.runInScope(() => {
      container.get(t('Flusher'))
      observe('caller')
    }, [[HTTP_CONTEXT, { id: 'req-1' }]])
    await sleep(10)
    expect(seen).toEqual(['dep: no scope', 'factory: no scope', 'caller: scope', 'timer: no scope'])
  })

  it('marks the scope as closed after fn settles', async () => {
    const container = create()
    await container.init()
    const scope = await container.runInScope(() => container.currentScope())
    expect(scope?.closed).toBe(true)
  })
})
