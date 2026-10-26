import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'bun:test'

const node = Bun.which('node')
const packageDir = fileURLToPath(new URL('..', import.meta.url))

it.skipIf(node === null)(
  'runs on Node.js from sources (plugin, interceptors, hooks, tracing, metrics server, Datadog)',
  () => {
    const result = spawnSync(node as string, ['--conditions=@znight/source', 'test/fixtures/node-smoke.mjs'], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      findSync: true,
      loadIsPromise: true,
      request: { requestId: 'req-node', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', status: 200 },
      correlated: true,
      spans: ['GET /users/:id', 'UserService.find', 'UserService.find', 'UserService.load'],
      metrics: [true, true],
      datadog: true,
      traceresponse: true,
    })
  },
  30_000,
)
