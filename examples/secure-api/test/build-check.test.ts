import { compile, formatDiagnostics } from '@znight/compiler'

import options from '../znight.config.js'
import { describe, expect, test as it } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname

/** Compiles the application plus one fixture, as `znight build` would (nothing is written). */
async function compileWith(fixture: string) {
  const result = await compile({ ...options, root: ROOT, include: ['src/**/*.ts', `test/fixtures/${fixture}`] })
  return { ...result, report: formatDiagnostics(result.diagnostics, { color: false, cwd: ROOT }) }
}

/**
 * The build-time half of the access checks, what the README's "Try breaking it" shows: the
 * application compiles cleanly, and a route without decision fails the build.
 */
describe('access decisions at build time', () => {
  it('compiles the application without any diagnostic', async () => {
    const result = await compile({ ...options, root: ROOT })

    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('fails the build on a route without access decision (ZNIGHT023)', async () => {
    const result = await compileWith('undecided.controller.ts')

    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'ZNIGHT023',
        severity: 'error',
        message: 'Route DELETE /drafts (DraftController.remove) has no "access" decision',
        location: expect.objectContaining({ file: `${ROOT}test/fixtures/undecided.controller.ts`, line: 18 }),
      }),
    ])
    expect(result.report).toContain(
      'hint: Add @Public(), @Authenticated() or @Roles(...) to the route or to DraftController',
    )
    expect(result.report).toContain('src/auth/access.ts') // where the group is declared required
  })

  it('fails the build on two decisions on the same target (ZNIGHT005)', async () => {
    const result = await compileWith('conflicting.controller.ts')

    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'ZNIGHT005',
        message: expect.stringContaining('already set by @Public on the same target'),
      }),
    ])
  })
})
