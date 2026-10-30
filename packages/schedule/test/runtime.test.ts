/**
 * Runs `fixtures/zone-check.ts` with Node.js 24 and Bun (RFC 0004 §7.11, §12.2): ICU data and timers
 * differ between the runtimes, the occurrences and the scheduler must not. `local` is checked under
 * `TZ=Europe/Paris`.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/zone-check.ts', import.meta.url))

interface Output {
  readonly occurrences: Record<string, string[]>
  readonly scheduler: Record<string, unknown>
}

async function run(command: string): Promise<Output> {
  const child = Bun.spawn([command, '--conditions=@znight/source', SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TZ: 'Europe/Paris' },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command} exited with ${code}: ${stderr}`)
  return JSON.parse(stdout) as Output
}

const EXPECTED: Record<string, string[]> = {
  '30 2 * * * Europe/Paris 2027-03-27T00:00:00Z': [
    '2027-03-27T01:30:00.000Z',
    '2027-03-28T01:00:00.000Z',
    '2027-03-29T00:30:00.000Z',
  ],
  '*/30 * * * * Europe/Paris 2027-03-27T23:45:00Z': [
    '2027-03-28T00:00:00.000Z',
    '2027-03-28T00:30:00.000Z',
    '2027-03-28T01:00:00.000Z',
    '2027-03-28T01:30:00.000Z',
    '2027-03-28T02:00:00.000Z',
  ],
  '30 2 * * * Europe/Paris 2026-10-24T00:00:00Z': [
    '2026-10-24T00:30:00.000Z',
    '2026-10-25T00:30:00.000Z',
    '2026-10-26T01:30:00.000Z',
  ],
  '*/30 * * * * Europe/Paris 2026-10-24T23:45:00Z': [
    '2026-10-25T00:00:00.000Z',
    '2026-10-25T00:30:00.000Z',
    '2026-10-25T01:00:00.000Z',
    '2026-10-25T01:30:00.000Z',
    '2026-10-25T02:00:00.000Z',
    '2026-10-25T02:30:00.000Z',
  ],
  '30 2 * * * America/New_York 2026-03-07T00:00:00Z': [
    '2026-03-07T07:30:00.000Z',
    '2026-03-08T07:00:00.000Z',
    '2026-03-09T06:30:00.000Z',
  ],
  '45 1 * * * Australia/Lord_Howe 2026-04-03T00:00:00Z': [
    '2026-04-03T14:45:00.000Z',
    '2026-04-04T14:45:00.000Z',
    '2026-04-05T15:15:00.000Z',
  ],
  '0 9 * * * Asia/Kathmandu 2026-06-01T00:00:00Z': ['2026-06-01T03:15:00.000Z', '2026-06-02T03:15:00.000Z'],
  '0 0 * * * America/Sao_Paulo 2018-11-03T00:00:00Z': [
    '2018-11-03T03:00:00.000Z',
    '2018-11-04T03:00:00.000Z',
    '2018-11-05T02:00:00.000Z',
  ],
  '0 12 * * * Pacific/Apia 2011-12-29T00:00:00Z': [
    '2011-12-29T22:00:00.000Z',
    '2011-12-30T10:00:00.000Z',
    '2011-12-30T22:00:00.000Z',
  ],
  '0 12 * * * US/Eastern 2026-07-01T00:00:00Z': ['2026-07-01T16:00:00.000Z'],
  '0 9 * * * +05:30 2026-06-01T00:00:00Z': ['2026-06-01T03:30:00.000Z'],
  // TZ=Europe/Paris: CEST in July, CET in January
  '0 12 * * * local 2026-07-01T00:00:00Z': ['2026-07-01T10:00:00.000Z'],
  '0 12 * * * local 2026-01-01T00:00:00Z': ['2026-01-01T11:00:00.000Z'],
}

const outputs: Record<string, Output> = {}

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('computes the expected occurrences and runs the scheduler on the system clock', async () => {
      const output = await run(runtime === 'node' ? 'node' : process.execPath)
      outputs[runtime] = output
      expect(output.occurrences).toEqual(EXPECTED)
      expect(output.scheduler).toEqual({
        ticks: true,
        aligned: true,
        increasing: true,
        warmed: true,
        manual: 'completed',
      })
    }, 30_000)
  })
}

describe('Node.js and Bun', () => {
  it('agree', () => {
    if (outputs['node'] === undefined || outputs['bun'] === undefined) return
    expect(outputs['node'].occurrences).toEqual(outputs['bun'].occurrences)
  })
})
