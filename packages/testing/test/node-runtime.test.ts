/**
 * The sources run unchanged on Node.js >= 24 (type stripping): without a test framework in scope,
 * mocks use the built-in spy.
 */

import { fileURLToPath } from 'node:url'

import { expect, test as it } from 'bun:test'

const node = Bun.which('node')
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const script = `
const { createMock, defineTestMetadata, detectMockFn, TestApp, TestBed } = await import(${JSON.stringify(entry)})
class Repository { find(id) { return id } }
class Service {
  constructor(repository) { this.repository = repository }
  get(id) { return this.repository.find(id) }
}
const metadata = defineTestMetadata({ providers: [Repository, { class: Service, deps: [Repository] }] })
const { instance, mocks } = await TestBed.create(Service, { metadata })
mocks.get(Repository).find.mockReturnValue('mocked')
const mock = createMock()
const app = await TestApp.create({ metadata })
const result = {
  source: detectMockFn().source,
  value: instance.get('1'),
  calls: mocks.get(Repository).find.mock.calls,
  awaited: (await mock) === mock,
  real: app.get(Service).get('2'),
  state: app.app.state,
}
await app.close()
console.log(JSON.stringify(result))
`

it.skipIf(node === null)('runs on Node.js with the built-in spy', () => {
  const run = Bun.spawnSync([node as string, '--conditions=@znight/source', '--input-type=module', '-e', script], {
    stderr: 'pipe',
  })
  expect(run.stderr.toString()).toBe('')
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(run.stdout.toString())).toEqual({
    source: 'builtin',
    value: 'mocked',
    calls: [['1']],
    awaited: true,
    real: '2',
    state: 'ready',
  })
})
