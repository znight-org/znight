/**
 * Unusual or invalid inputs never crash the analysis.
 */
import type { FixtureAnalysis } from './helpers.ts'

import { analyzeRoot, codes, provider, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const app = tempApp({
  'src/loops.ts': `
import { Injectable } from '@znight/core'
// @ts-expect-error circular inheritance
@Injectable() export class LoopA extends LoopB {}
// @ts-expect-error circular inheritance
export class LoopB extends LoopA {}
`,
  'src/weird.ts': `
import { Injectable } from '@znight/core'
const decorators: Record<string, () => ClassDecorator> = {}
export const OPTIONS = [{ scope: 'transient' }] as const

@Injectable(...OPTIONS)
export class Spread {
  static { void 0 }
  [key: string]: unknown
}

@(decorators['dynamic'] as () => ClassDecorator)()
export class Computed {}

export namespace NS {
  @Injectable() export class Inside {}
}

@Injectable()
export class Overloaded {
  constructor(value: string)
  constructor(value?: string) { void value }
}
`,
  'src/broken.ts': 'export class Broken {',
  'src/unicode.ts': `
import { Injectable } from '@znight/core'
@Injectable() export class Café {}
@Injectable() export class Utilisateur { constructor(readonly café: Café) {} }
`,
})

let result: FixtureAnalysis

beforeAll(async () => {
  result = await analyzeRoot(app.root)
})
afterAll(() => app.cleanup())

describe('robustness', () => {
  it('analyses what it can and reports the rest', () => {
    expect(codes(result)).toEqual(['ZNIGHT010 src/loops.ts:6:28', 'ZNIGHT010 src/weird.ts:22:23'])
    expect(result.diagnostics[0]?.message).toBe('Circular inheritance through LoopA')
    expect(result.diagnostics[1]?.message).toBe(
      "Parameter 'value' of Overloaded: a value of type 'string' cannot be injected without a qualifier",
    )
  })

  it('evaluates spread decorator arguments', () => {
    expect(provider(result, 'src/weird.ts#Spread').scope).toBe('transient')
  })

  it('ignores decorators it cannot identify and classes inside namespaces', () => {
    const tokens = result.graph.providers.map(node => node.token)
    expect(tokens).not.toContain('src/weird.ts#Computed')
    expect(tokens).not.toContain('src/weird.ts#NS.Inside')
    expect(result.classes.find(cls => cls.name === 'Computed')?.decorators[0]).toMatchObject({
      identity: undefined,
      owner: undefined,
      called: true,
    })
  })

  it('keeps going when a file has a syntax error', () => {
    expect(result.project.syntaxErrors().map(error => error.file.path.slice(app.root.length + 1))).toEqual([
      'src/broken.ts',
    ])
  })

  it('handles non-ASCII identifiers', () => {
    expect(provider(result, 'src/unicode.ts#Utilisateur').deps.map(dep => dep.ref)).toEqual(['src/unicode.ts#Café'])
  })
})
