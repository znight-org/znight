import { ERROR_DESCRIPTIONS, ErrorCode, ZnightError } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

/** Allocated ranges of the catalogue (rfcs/README.md, architecture §4.8): first and last number. */
const RANGES: readonly (readonly [owner: string, first: number, last: number])[] = [
  ['core, compiler, http, messaging, config, observability', 1, 29],
  ['@znight/openapi', 30, 39],
  ['@znight/schedule', 40, 49],
  ['@znight/websocket (reserved)', 50, 59],
  ['@znight/graphql (reserved)', 60, 69],
]

const numberOf = (code: string): number => Number(code.slice('ZNIGHT'.length))

describe('ErrorCode', () => {
  const codes = Object.values(ErrorCode)

  it('codes are well-formed, unique and in ascending order', () => {
    for (const code of codes) expect(code).toMatch(/^ZNIGHT\d{3}$/)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.map(numberOf)).toEqual(codes.map(numberOf).toSorted((a, b) => a - b))
  })

  it('every code belongs to an allocated range, and each range is filled from its start without gaps', () => {
    for (const [owner, first, last] of RANGES) {
      const numbers = codes.map(numberOf).filter(n => n >= first && n <= last)
      expect({ owner, numbers }).toEqual({ owner, numbers: numbers.map((_, index) => first + index) })
    }
    const allocated = (n: number): boolean => RANGES.some(([, first, last]) => n >= first && n <= last)
    expect(codes.filter(code => !allocated(numberOf(code)))).toEqual([])
  })

  it('describes every code, and nothing else', () => {
    expect(Object.keys(ERROR_DESCRIPTIONS).toSorted()).toEqual([...codes].toSorted())
    for (const code of codes) expect(ERROR_DESCRIPTIONS[code].length).toBeGreaterThan(10)
  })

  it('has the codes of the security, openapi and schedule RFCs', () => {
    expect(ErrorCode).toMatchObject({
      MissingRouteDecision: 'ZNIGHT023',
      InvalidOpenApiDefinition: 'ZNIGHT030',
      UndocumentedResponse: 'ZNIGHT031',
      UnrepresentableType: 'ZNIGHT032',
      DuplicateOperationId: 'ZNIGHT033',
      SchemaNameConflict: 'ZNIGHT034',
      InconsistentOperation: 'ZNIGHT035',
      InvalidSecurityRequirement: 'ZNIGHT036',
      SchemaConversionFailed: 'ZNIGHT037',
      InvalidSchedule: 'ZNIGHT040',
      DuplicateJob: 'ZNIGHT041',
      UnknownJob: 'ZNIGHT042',
      MissingLockStore: 'ZNIGHT043',
      JobAborted: 'ZNIGHT044',
    })
  })

  it('a ZnightError carries a package code like any other', () => {
    const error = new ZnightError(ErrorCode.UnknownJob, "No job named 'digest.dialy'", {
      hints: ["Did you mean 'digest.daily'?"],
    })
    expect(error.code).toBe('ZNIGHT042')
    expect(error.message).toBe("ZNIGHT042: No job named 'digest.dialy'")
    expect(error.hints).toEqual(["Did you mean 'digest.daily'?"])
  })
})
