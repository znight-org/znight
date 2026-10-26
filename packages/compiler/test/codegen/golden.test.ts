/**
 * Golden snapshots of the generated module for representative applications (the compiler version
 * is replaced by `<version>` so that releases do not invalidate them).
 */

import { compile } from '../../src/compiler.ts'
import { ANALYSIS } from '../analysis/helpers.ts'
import { compileFixture, render, stable } from './helpers.ts'
import { webExtension } from './web-extension.ts'
import { describe, expect, test as it } from 'bun:test'

describe('golden generated modules', () => {
  it('core features (build mode: no source locations)', async () => {
    const result = await compileFixture('app', { mode: 'build' })
    expect(result.diagnostics).toEqual([])
    expect(result.code).not.toContain('source:')
    expect(stable(result.code)).toMatchSnapshot()
  })

  it('import naming', async () => {
    const result = await compileFixture('naming', { mode: 'build' })
    expect(result.diagnostics).toEqual([])
    expect(stable(result.code)).toMatchSnapshot()
  })

  it('compiler extension section, custom factory and constants', async () => {
    const result = await compileFixture('web', { mode: 'build', extensions: [webExtension] })
    expect(result.diagnostics).toEqual([])
    expect(stable(result.code)).toMatchSnapshot()
  })

  it('the analysis fixture (externals, interceptors, factories, generics, extensions)', async () => {
    const root = `${ANALYSIS}/app`
    const result = await compile({ root, conditions: ['@znight/source'], mode: 'serve' })
    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    expect(render(root, result.diagnostics)).toContain('fake-http validated')
    expect(result.code).toContain("source: { file: 'src/users/user.service.ts', line: 18, column: 14 }")
    expect(stable(result.code)).toMatchSnapshot()
  })

  it('emits source locations according to sourceLocations and mode', async () => {
    const always = await compileFixture('naming', { mode: 'build', sourceLocations: 'always' })
    expect(always.code).toContain("source: { file: 'src/consumer.ts'")
    const never = await compileFixture('naming', { mode: 'serve', sourceLocations: false })
    expect(never.code).not.toContain('source:')
    const test = await compileFixture('naming', { mode: 'test' })
    expect(test.code).toContain('source:')
  })

  it('maps import extensions (js, ts, none)', async () => {
    const ts = await compileFixture('naming', { mode: 'build', importExtension: 'ts' })
    expect(ts.code).toContain("from '../consumer.ts'")
    const none = await compileFixture('naming', { mode: 'build', importExtension: 'none' })
    expect(none.code).toContain("from '../consumer'")
  })
})
