/** Child processes: the runtimes, servers started on a free port, their memory, their shutdown. */
import type { Subprocess } from 'bun'
import type { Runtime } from './variants.ts'

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

/** Executable of each runtime: `node` from the PATH, and the Bun running this script. */
export function runtimeBinary(runtime: Runtime): string {
  if (runtime === 'bun') return process.execPath
  const node = Bun.which('node')
  if (node === null) throw new Error('node is not on the PATH')
  return node
}

/** `process.version` of a runtime, without the leading `v`. */
export function runtimeVersion(runtime: Runtime): string {
  if (runtime === 'bun') return Bun.version
  return execFileSync(runtimeBinary('node'), ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '')
}

/** A TCP port free on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export interface Started {
  readonly child: Subprocess<'ignore', 'ignore', 'pipe'>
  readonly port: number
  /** Milliseconds from the spawn to the first successful response. */
  readonly readyMs: number
}

export interface StartOptions {
  readonly runtime: Runtime
  readonly cwd: string
  readonly entry: string
  readonly env: Readonly<Record<string, string>>
  /** Path requested until it answers `200`. */
  readonly probe: string
  readonly timeoutMs?: number
}

/**
 * Starts a server and requests `probe` until it answers `200`, every millisecond: the measured time
 * covers the runtime start, the imports, the application bootstrap and the first request.
 */
export async function start(options: StartOptions): Promise<Started> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}${options.probe}`
  const timeoutMs = options.timeoutMs ?? 15_000
  const started = performance.now()
  const child = Bun.spawn([runtimeBinary(options.runtime), join(options.cwd, options.entry)], {
    cwd: options.cwd,
    env: { ...process.env, NODE_ENV: 'production', ...options.env, PORT: String(port) },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (;;) {
    try {
      const response = await fetch(url)
      await response.arrayBuffer()
      if (response.status === 200) return { child, port, readyMs: performance.now() - started }
      throw new Error(`${url} answered ${response.status}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(url)) {
        await stop(child)
        throw error
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`The server exited with code ${child.exitCode}:\n${await new Response(child.stderr).text()}`)
    }
    if (performance.now() - started > timeoutMs) {
      await stop(child)
      throw new Error(`${url} did not answer within ${timeoutMs} ms`)
    }
    await Bun.sleep(1)
  }
}

/** Resident set size of a process, in MiB (`ps`, macOS and Linux). */
export function rssMiB(pid: number): number {
  const kib = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  return kib / 1024
}

/** Stops a process with SIGTERM, then SIGKILL after 5 seconds. */
export async function stop(child: Subprocess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
  await child.exited
  clearTimeout(timer)
}
