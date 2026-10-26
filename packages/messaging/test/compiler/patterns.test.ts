/**
 * Message type patterns: same matching semantics as the runtime handler selection, and a sound
 * "covers" relation (a reported pattern can really never be selected).
 */
import { isPattern, matchesPattern, patternCovers } from '../../src/compiler/patterns.ts'
import { describe, expect, it } from 'bun:test'

/** The runtime translation (`consumers.ts`): `*` matches any sequence of characters. */
function runtimeRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 's')
}

/** Every string of length <= `max` over `alphabet`. */
function strings(alphabet: readonly string[], max: number): string[] {
  const all = ['']
  let layer = ['']
  for (let length = 1; length <= max; length++) {
    layer = layer.flatMap(prefix => alphabet.map(char => prefix + char))
    all.push(...layer)
  }
  return all
}

describe('patterns', () => {
  it('recognises patterns', () => {
    expect(isPattern('order.*')).toBe(true)
    expect(isPattern('*')).toBe(true)
    expect(isPattern('order.created')).toBe(false)
    expect(isPattern('')).toBe(false)
  })

  it('matches like the runtime', () => {
    const patterns = ['*', 'a*', '*a', 'a*b', '*.*', 'a.*.b', '**', 'a**b*', 'ab', '', '.*', '*(*)']
    const subjects = [...strings(['a', 'b', '.'], 4), 'a(b)', '(', 'a\nb', '[a]']
    for (const pattern of patterns) {
      const regex = runtimeRegExp(pattern)
      for (const subject of subjects) {
        expect({ pattern, subject, match: matchesPattern(pattern, subject) }).toEqual({
          pattern,
          subject,
          match: regex.test(subject),
        })
      }
    }
  })

  it('detects patterns covered by another one', () => {
    expect(patternCovers('order.*', 'order.created.*')).toBe(true)
    expect(patternCovers('*', 'audit.*')).toBe(true)
    expect(patternCovers('*.created', 'order.*.created')).toBe(true)
    expect(patternCovers('a*', 'a**')).toBe(true)
    expect(patternCovers('order.*', 'order.*')).toBe(true)
    expect(patternCovers('*a*', '*a*a*')).toBe(true)
    expect(patternCovers('order.*', '*.created')).toBe(false)
    expect(patternCovers('*.created', 'order.*')).toBe(false)
    expect(patternCovers('order.created.*', 'order.*')).toBe(false)
    expect(patternCovers('a*b', 'a*')).toBe(false)
  })

  it('never reports a pattern that can still be selected (sound)', () => {
    const alphabet = ['a', 'b', '*']
    const patterns = strings(alphabet, 4).filter(isPattern)
    const subjects = strings(['a', 'b'], 6)
    for (const outer of patterns) {
      const outerRegex = runtimeRegExp(outer)
      for (const inner of patterns) {
        if (!patternCovers(outer, inner)) continue
        const innerRegex = runtimeRegExp(inner)
        const escaping = subjects.find(subject => innerRegex.test(subject) && !outerRegex.test(subject))
        expect({ outer, inner, escaping }).toEqual({ outer, inner, escaping: undefined })
      }
    }
  })
})
