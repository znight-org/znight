/**
 * Runs `fixtures/conformance-node.ts` with `node --test` on Node.js 24: the driver conformance suite
 * (built-in transport and Yoga driver, every adapter) on Node.js, with `node:test` as the framework
 * (`describeDriverConformance()` is framework-neutral). `conformance.test.ts` runs it on Bun.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('../fixtures/conformance-node.ts', import.meta.url))

describe('the driver conformance suite on Node.js', () => {
  it('passes for the built-in transport and the Yoga driver on every adapter', async () => {
    const child = Bun.spawn(['node', '--conditions=@znight/source', '--test', '--test-reporter=tap', SCRIPT], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    // the TAP summary: `# pass 88`, `# fail 0`
    const count = (name: string): number => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(stdout)?.[1])
    expect({ code, fail: count('fail'), stderr }).toEqual({ code: 0, fail: 0, stderr: '' })
    expect(count('pass')).toBe(88)
  }, 120_000)
})
