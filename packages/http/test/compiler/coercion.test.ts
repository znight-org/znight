/**
 * Type-based coercion of route parameters, query values and headers (README, "Compiler contract":
 * `coerce.X` by declared type), from the annotation or the default value.
 */
import type { HttpParamData } from '../../src/compiler/index.ts'
import type { HttpAnalysis } from './helpers.ts'

import { analyzeApp, cleanupApps, generateSection, render, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

let result: HttpAnalysis
let code: string

beforeAll(async () => {
  const app = tempApp({
    'src/types.ts': `
export type Sort = 'asc' | 'desc'
export type Brand<T, B extends string> = T & { readonly __brand: B }
export type Cents = Brand<number, 'Cents'>
export enum Level { Low, High }
export enum Mode { Fast = 'fast', Safe = 'safe' }
export const enum Packed { A = 'a' }
export const DEFAULT_PAGE = 1
`,
    'src/coerce.controller.ts': `
import { Controller, Get, Headers, Param, Query } from '@znight/http'
import type { Brand, Cents, Sort } from './types.ts'
import { DEFAULT_PAGE, Level, Mode } from './types.ts'

@Controller('/c')
export class CoerceController {
  @Get('/:id/:at')
  scalars(
    @Param('id') id: string,
    @Param('at') at: Date,
    @Query('n') n: number,
    @Query('b') b: boolean,
    @Query('big') big: bigint,
    @Headers('X-Text') text: string,
  ) { return [id, at, n, b, big, text] }

  @Get('/literals')
  literals(
    @Query('sort') sort: Sort,
    @Query('one') one: 1 | 2,
    @Query('flag') flag: 'auto' | boolean,
    @Query('lit') lit: 'only',
    @Query('level') level: Level,
    @Query('mode') mode: Mode,
  ) { return [sort, one, flag, lit, level, mode] }

  @Get('/arrays')
  arrays(
    @Query('ids') ids: number[],
    @Query('ro') ro: readonly string[],
    @Query('gen') gen: Array<Sort>,
    @Query('cents') cents: Cents[],
  ) { return [ids, ro, gen, cents] }

  @Get('/optional/:id')
  optional(
    @Param('id') id?: string,
    @Query('a') a?: number,
    @Query('b') b: number | undefined,
    @Query('c') c: number | null,
    @Query('d') d: Brand<string, 'D'> | undefined,
    @Query('e') e = DEFAULT_PAGE,
    @Query('f') f = 'x',
    @Query('g') g = [1, 2],
    @Query('h') h = new Date(0),
    @Query('i') i = 10n,
    @Query('j') j = false,
  ) { return [id, a, b, c, d, e, f, g, h, i, j] }

  @Get('/raw')
  raw(@Query('u') u: unknown, @Headers('x-u') x: unknown) { return [u, x] }
}
`,
  })
  result = await analyzeApp(app.root)
  code = generateSection(result).code
})

afterAll(cleanupApps)

function params(handler: string): HttpParamData[] {
  const route = result.controllers[0]?.routes.find(candidate => candidate.handler === handler)
  if (!route) {
    throw new Error(`no route ${handler}`)
  }
  return [...route.params]
}

/** `name: plan` with `!` when the result is cast. */
function plans(handler: string): Record<string, unknown> {
  return Object.fromEntries(
    params(handler).map(param => [`${param.key}${param.coercion?.cast ? '!' : ''}`, param.coercion?.plan]),
  )
}

/** The generated argument expressions of a route, one per line. */
function args(handler: string): string[] {
  const line = code.split('\n').find(text => text.includes(`=> c.${handler}(`)) ?? ''
  const call = line.slice(line.indexOf(`c.${handler}(`) + `c.${handler}(`.length, -2)
  // split on top-level commas
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of call) {
    if ('([{'.includes(char)) depth++
    if (')]}'.includes(char)) depth--
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current.trim())
  return parts
}

it('reports nothing', () => {
  expect(render(result)).toEqual([])
})

describe('scalars', () => {
  it('string, Date, number, boolean, bigint', () => {
    expect(plans('scalars')).toEqual({
      id: { kind: 'string' },
      at: { kind: 'date' },
      n: { kind: 'number' },
      b: { kind: 'boolean' },
      big: { kind: 'bigint' },
      'x-text': { kind: 'string' },
    })
    expect(args('scalars')).toEqual([
      `coerce.string(ctx.params['id'], 'param "id"')`,
      `coerce.date(ctx.params['at'], 'param "at"')`,
      `coerce.number(ctx.query['n'], 'query "n"')`,
      `coerce.boolean(ctx.query['b'], 'query "b"')`,
      `coerce.bigint(ctx.query['big'], 'query "big"')`,
      `coerce.string(ctx.headers['x-text'], 'header "x-text"')`,
    ])
  })
})

describe('literal types and enums', () => {
  it('literal unions, booleans in unions, single literals, numeric and string enums', () => {
    expect(plans('literals')).toEqual({
      sort: { kind: 'enum', values: ['asc', 'desc'] },
      one: { kind: 'enum', values: [1, 2] },
      flag: { kind: 'enum', values: ['auto', false, true] },
      lit: { kind: 'enum', values: ['only'] },
      'level!': { kind: 'enum', values: [0, 1] },
      'mode!': { kind: 'enum', values: ['fast', 'safe'] },
    })
    expect(args('literals')).toEqual([
      `coerce.enum(ctx.query['sort'], 'query "sort"', ['asc', 'desc'])`,
      `coerce.enum(ctx.query['one'], 'query "one"', [1, 2])`,
      `coerce.enum(ctx.query['flag'], 'query "flag"', ['auto', false, true])`,
      `coerce.enum(ctx.query['lit'], 'query "lit"', ['only'])`,
      `coerce.enum(ctx.query['level'], 'query "level"', [0, 1]) as never`,
      `coerce.enum(ctx.query['mode'], 'query "mode"', ['fast', 'safe']) as never`,
    ])
  })
})

describe('arrays', () => {
  it('T[], readonly T[], Array<T>, arrays of branded primitives', () => {
    expect(plans('arrays')).toEqual({
      ids: { kind: 'array', item: { kind: 'number' } },
      ro: { kind: 'array', item: { kind: 'string' } },
      gen: { kind: 'array', item: { kind: 'enum', values: ['asc', 'desc'] } },
      'cents!': { kind: 'array', item: { kind: 'number' } },
    })
    expect(args('arrays')).toEqual([
      `coerce.array(ctx.query['ids'], 'query "ids"', coerce.number)`,
      `coerce.array(ctx.query['ro'], 'query "ro"', coerce.string)`,
      `coerce.array(ctx.query['gen'], 'query "gen"', (v, l) => coerce.enum(v, l, ['asc', 'desc']))`,
      `coerce.array(ctx.query['cents'], 'query "cents"', coerce.number) as never`,
    ])
  })
})

describe('optional values', () => {
  it('?, | undefined, | null, default values (types inferred from them)', () => {
    expect(plans('optional')).toEqual({
      id: { kind: 'string' }, // a route parameter is always present
      a: { kind: 'optional', item: { kind: 'number' } },
      b: { kind: 'optional', item: { kind: 'number' } },
      'c!': { kind: 'optional', item: { kind: 'number' } }, // undefined is not assignable to number | null
      'd!': { kind: 'optional', item: { kind: 'string' } },
      e: { kind: 'optional', item: { kind: 'number' } },
      f: { kind: 'optional', item: { kind: 'string' } },
      g: { kind: 'optional', item: { kind: 'array', item: { kind: 'number' } } },
      h: { kind: 'optional', item: { kind: 'date' } },
      i: { kind: 'optional', item: { kind: 'bigint' } },
      j: { kind: 'optional', item: { kind: 'boolean' } },
    })
    expect(params('optional').map(param => [param.key, param.type, param.optional])).toEqual([
      ['id', 'string', false],
      ['a', 'number', true],
      ['b', 'number | undefined', true],
      ['c', 'null | number', true],
      ['d', '{ readonly __brand: B } & string | undefined', true], // opaque members keep their source text
      ['e', 'number', true],
      ['f', 'string', true],
      ['g', 'number[]', true],
      ['h', 'Date', true],
      ['i', 'bigint', true],
      ['j', 'boolean', true],
    ])
    expect(args('optional').slice(0, 4)).toEqual([
      `coerce.string(ctx.params['id'], 'param "id"')`,
      `coerce.optional(ctx.query['a'], 'query "a"', coerce.number)`,
      `coerce.optional(ctx.query['b'], 'query "b"', coerce.number)`,
      `coerce.optional(ctx.query['c'], 'query "c"', coerce.number) as never`,
    ])
    expect(args('optional')[7]).toBe(
      `coerce.optional(ctx.query['g'], 'query "g"', (v, l) => coerce.array(v, l, coerce.number))`,
    )
  })

  it('unknown values are passed as is', () => {
    expect(plans('raw')).toEqual({ u: { kind: 'raw' }, 'x-u': { kind: 'raw' } })
    expect(args('raw')).toEqual([`ctx.query['u'] as never`, `ctx.headers['x-u'] as never`])
  })
})
