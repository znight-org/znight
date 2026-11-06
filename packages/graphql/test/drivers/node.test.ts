/**
 * Runs fixture scripts with `node --test` on Node.js 24: `fixtures/conformance-node.ts`, the driver
 * conformance suite (built-in transport and Yoga driver, every adapter) with `node:test` as the
 * framework (`describeDriverConformance()` is framework-neutral), and `fixtures/yoga-responses-node.ts`,
 * how the Yoga driver sends the responses of Yoga's ponyfills. `conformance.test.ts` and
 * `yoga-responses.test.ts` run them on Bun.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

/** Runs a fixture with `node --test`: its exit code, TAP pass / fail counts and stderr. */
async function nodeTest(fixture: string): Promise<{ code: number; pass: number; fail: number; stderr: string }> {
  const script = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url))
  const child = Bun.spawn(['node', '--conditions=@znight/source', '--test', '--test-reporter=tap', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  // the TAP summary: `# pass 112`, `# fail 0`
  const count = (name: string): number => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(stdout)?.[1])
  return { code, pass: count('pass'), fail: count('fail'), stderr }
}

describe('the driver conformance suite on Node.js', () => {
  it('passes for the built-in transport and the Yoga driver on every adapter', async () => {
    const { pass, ...outcome } = await nodeTest('conformance-node.ts')
    expect(outcome).toEqual({ code: 0, fail: 0, stderr: '' })
    expect(pass).toBe(112)
  }, 120_000)
})

describe("the Yoga driver's responses on Node.js", () => {
  it('sends the ponyfill responses of Yoga on every adapter (text, bytes, headers, cookies, event streams)', async () => {
    const { pass, ...outcome } = await nodeTest('yoga-responses-node.ts')
    expect(outcome).toEqual({ code: 0, fail: 0, stderr: '' })
    expect(pass).toBe(24)
  }, 60_000)
})
