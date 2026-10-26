/**
 * A process whose only ingress is a consumer of a driver holding no handle (the memory driver) stays
 * alive once started, until a signal stops it gracefully (consumers stopped, providers disposed).
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const node = Bun.which('node')

describe.each([
  ['Bun', process.execPath],
  ['Node.js', node],
])('on %s', (_runtime, executable) => {
  it.skipIf(executable === null)(
    'keeps a memory-driver worker alive until a signal stops it gracefully',
    async () => {
      const child = Bun.spawn([executable as string, '--conditions=@znight/source', 'test/fixtures/memory-worker.ts'], {
        cwd: packageDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let stdout = ''
      const readUntil = async (text: string): Promise<void> => {
        while (!stdout.includes(text)) {
          const { value, done } = await reader.read()
          if (done) return
          stdout += decoder.decode(value)
        }
      }
      await readUntil('started')
      expect(stdout).toContain('started')
      // without a handle, the event loop would drain and the process exit without shutdown
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(child.exitCode).toBeNull()
      child.kill('SIGTERM')
      await readUntil('disposed')
      const exitCode = await child.exited
      expect(stdout.split('\n').filter(Boolean)).toEqual(['started', 'stopped', 'disposed'])
      expect(exitCode).toBe(0)
      expect(await new Response(child.stderr).text()).toBe('')
    },
    15_000,
  )
})
