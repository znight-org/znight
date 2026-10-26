import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createServer } from 'node:http'
import { ErrorCode, type ZnightError } from '@znight/core'

import { ConfigLoaderError, dotenv, inline, loadConfigSource, vault } from '../../src/index.ts'
import { caught, tempDir } from '../helpers.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

const TOKEN = 'test-token'

interface Recorded {
  readonly url: string
  readonly token: string | undefined
  readonly namespace: string | undefined
  readonly request: string | undefined
}

let server: Server
let address: string
let requests: Recorded[] = []
let flaky = 0

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? ''
  requests.push({
    url,
    token: req.headers['x-vault-token'] as string | undefined,
    namespace: req.headers['x-vault-namespace'] as string | undefined,
    request: req.headers['x-vault-request'] as string | undefined,
  })
  if (req.headers['x-vault-token'] !== TOKEN) {
    send(res, 403, { errors: ['permission denied'] })
    return
  }
  switch (url) {
    case '/v1/secret/data/myapp':
      send(res, 200, {
        data: { data: { DB_PASSWORD: 'kv2-password', database: { host: 'vault-host' } }, metadata: { version: 3 } },
      })
      break
    case '/v1/secret/data/myapp/override':
      send(res, 200, { data: { data: { DB_PASSWORD: 'override-password' } } })
      break
    case '/v1/kv/myapp':
      send(res, 200, { data: { API_KEY: 'kv1-key' } })
      break
    case '/v1/team/a/data/my%20app%3F':
      send(res, 200, { data: { data: { ENCODED: 'yes' } } })
      break
    case '/v1/kv/team-a/data/svc':
      send(res, 200, { data: { data: { MOUNTED: 'yes' } } })
      break
    case '/v1/secret/data/flaky':
      flaky++
      if (flaky < 3) send(res, 503, { errors: ['sealed'] })
      else send(res, 200, { data: { data: { FLAKY: 'ok' } } })
      break
    case '/v1/secret/data/down':
      send(res, 500, 'not json')
      break
    case '/v1/secret/data/slow':
      setTimeout(() => send(res, 200, { data: { data: { SLOW: 'late' } } }), 300)
      return
    case '/v1/secret/data/kv1-shaped':
      send(res, 200, { data: { KEY: 'value' } })
      break
    case '/v1/secret/data/bad-request':
      res.writeHead(400)
      res.end('plain text')
      return
    default:
      send(res, 404, { errors: [] })
      break
  }
}

beforeAll(async () => {
  server = createServer(handle)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => {
  requests = []
  flaky = 0
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})

const fast = { retryDelayMs: 1 } as const

describe('vault()', () => {
  it('reads KV v2 secrets with the token and the request header', async () => {
    const source = await loadConfigSource([vault({ address, token: TOKEN, path: 'secret/myapp' })], { env: {} })
    expect(source.get('DB_PASSWORD')).toBe('kv2-password')
    expect(source.get('database.host')).toBe('vault-host')
    expect(source.origin('DB_PASSWORD')).toBe('vault:secret/myapp')
    expect(requests).toEqual([{ url: '/v1/secret/data/myapp', token: TOKEN, namespace: undefined, request: 'true' }])
  })

  it('reads KV v1 secrets', async () => {
    const source = await loadConfigSource([vault({ address, token: TOKEN, path: 'kv/myapp', kvVersion: 1 })], {
      env: {},
    })
    expect(source.get('API_KEY')).toBe('kv1-key')
  })

  it('reads several paths, later paths overriding earlier ones', async () => {
    const source = await loadConfigSource(
      [vault({ address, token: TOKEN, path: ['secret/myapp', 'secret/myapp/override'] })],
      { env: {} },
    )
    expect(source.get('DB_PASSWORD')).toBe('override-password')
    expect(source.origin('DB_PASSWORD')).toBe('vault:secret/myapp/override')
    expect(source.get('database.host')).toBe('vault-host')
  })

  it('supports explicit mounts, encodes path segments and normalises slashes', async () => {
    const mounted = await loadConfigSource(
      [vault({ address: `${address}/`, token: TOKEN, mount: '/kv/team-a/', path: '/svc/' })],
      {
        env: {},
      },
    )
    expect(mounted.get('MOUNTED')).toBe('yes')
    const encoded = await loadConfigSource([vault({ address, token: TOKEN, mount: 'team/a', path: 'my app?' })], {
      env: {},
    })
    expect(encoded.get('ENCODED')).toBe('yes')
  })

  it('mounts the data under a key', async () => {
    const source = await loadConfigSource([vault({ address, token: TOKEN, path: 'secret/myapp', key: 'vault' })], {
      env: {},
    })
    expect(source.get('vault.DB_PASSWORD')).toBe('kv2-password')
    expect(source.has('DB_PASSWORD')).toBe(false)
  })

  it('sends the namespace header', async () => {
    await loadConfigSource([vault({ address, token: TOKEN, path: 'secret/myapp', namespace: 'team-a' })], { env: {} })
    expect(requests[0]?.namespace).toBe('team-a')
  })

  it('reads VAULT_ADDR, VAULT_TOKEN and VAULT_NAMESPACE from previous loaders, then the environment', async () => {
    const fromLoaders = await loadConfigSource(
      [inline({ VAULT_ADDR: address, VAULT_TOKEN: TOKEN, VAULT_NAMESPACE: 'ns' }), vault({ path: 'secret/myapp' })],
      { env: {} },
    )
    expect(fromLoaders.get('DB_PASSWORD')).toBe('kv2-password')
    expect(requests[0]?.namespace).toBe('ns')

    const fromEnv = await loadConfigSource([vault({ path: 'secret/myapp' })], {
      env: { VAULT_ADDR: ` ${address} `, VAULT_TOKEN: TOKEN },
    })
    expect(fromEnv.get('DB_PASSWORD')).toBe('kv2-password')
  })

  it('works with VAULT_* variables from a .env file', async () => {
    const { dir, cleanup } = await tempDir({ '.env': `VAULT_ADDR=${address}\nVAULT_TOKEN=${TOKEN}\n` })
    try {
      const source = await loadConfigSource([dotenv(), vault({ path: 'secret/myapp' })], { cwd: dir, env: {} })
      expect(source.get('DB_PASSWORD')).toBe('kv2-password')
    } finally {
      cleanup()
    }
  })

  it('reads the token from a file', async () => {
    const { dir, cleanup } = await tempDir({ token: `  ${TOKEN}\n`, empty: '\n' })
    try {
      const source = await loadConfigSource([vault({ address, tokenFile: 'token', path: 'secret/myapp' })], {
        cwd: dir,
        env: {},
      })
      expect(source.get('DB_PASSWORD')).toBe('kv2-password')
      for (const tokenFile of ['empty', 'missing']) {
        const error = await caught(() =>
          loadConfigSource([vault({ address, tokenFile, path: 'secret/myapp' })], { cwd: dir, env: {} }),
        )
        expect(error.message).toContain(`the token file ${tokenFile} is missing or empty`)
      }
    } finally {
      cleanup()
    }
  })

  it('requires an address and a token', async () => {
    const noAddress = await caught(() => loadConfigSource([vault({ token: TOKEN, path: 'secret/myapp' })], { env: {} }))
    expect(noAddress).toBeInstanceOf(ConfigLoaderError)
    expect(noAddress.message).toContain('no server address')
    const badAddress = await caught(() =>
      loadConfigSource([vault({ address: 'not a url', token: TOKEN, path: 'secret/myapp' })], { env: {} }),
    )
    expect(badAddress.message).toContain('invalid server address "not a url"')
    const noToken = await caught(() => loadConfigSource([vault({ address, path: 'secret/myapp' })], { env: {} }))
    expect(noToken.message).toContain('no token')
  })

  it('fails on missing secrets unless optional', async () => {
    const error = await caught(() =>
      loadConfigSource([vault({ address, token: TOKEN, path: 'secret/unknown' })], { env: {} }),
    )
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toBe('ZNIGHT006: Config loader "vault" failed: secret secret/unknown not found (HTTP 404)')
    expect(requests).toHaveLength(1)

    const source = await loadConfigSource(
      [vault({ address, token: TOKEN, path: ['secret/unknown', 'secret/myapp'], optional: true })],
      { env: {} },
    )
    expect(source.get('DB_PASSWORD')).toBe('kv2-password')
    expect(source.describe?.()).toBe('vault:secret/myapp')
  })

  it('reports permission errors without retrying and never leaks the token', async () => {
    const error = await caught(() =>
      loadConfigSource([vault({ address, token: 'wrong-token', path: 'secret/myapp' })], { env: {} }),
    )
    expect(error.message).toBe(
      'ZNIGHT006: Config loader "vault" failed: cannot read secret secret/myapp: HTTP 403: permission denied',
    )
    expect((error as ZnightError).hints).toEqual(['Check the token and its policies'])
    expect(error.message).not.toContain('wrong-token')
    expect(requests).toHaveLength(1)

    const plain = await caught(() =>
      loadConfigSource([vault({ address, token: TOKEN, path: 'secret/bad-request' })], { env: {} }),
    )
    expect(plain.message).toContain('cannot read secret secret/bad-request: HTTP 400')
  })

  it('retries transient failures with backoff', async () => {
    const source = await loadConfigSource([vault({ address, token: TOKEN, path: 'secret/flaky', ...fast })], {
      env: {},
    })
    expect(source.get('FLAKY')).toBe('ok')
    expect(requests).toHaveLength(3)
  })

  it('gives up after the configured retries', async () => {
    const error = await caught(() =>
      loadConfigSource([vault({ address, token: TOKEN, path: 'secret/down', retries: 1, ...fast })], { env: {} }),
    )
    expect(error.message).toBe(
      'ZNIGHT006: Config loader "vault" failed: cannot read secret secret/down after 2 attempt(s): HTTP 500',
    )
    expect(requests).toHaveLength(2)
  })

  it('times out slow requests', async () => {
    const error = await caught(() =>
      loadConfigSource([vault({ address, token: TOKEN, path: 'secret/slow', timeoutMs: 50, retries: 0 })], { env: {} }),
    )
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('cannot read secret secret/slow after 1 attempt(s)')
    expect((error.cause as Error).name).toBe('TimeoutError')
  })

  it('reports network errors', async () => {
    const error = await caught(() =>
      loadConfigSource([vault({ address: 'http://127.0.0.1:1', token: TOKEN, path: 'secret/myapp', retries: 0 })], {
        env: {},
      }),
    )
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('cannot read secret secret/myapp after 1 attempt(s)')
  })

  it('detects a KV version mismatch', async () => {
    const error = await caught(() =>
      loadConfigSource([vault({ address, token: TOKEN, path: 'secret/kv1-shaped' })], { env: {} }),
    )
    expect(error.message).toContain(
      'unexpected response for secret/kv1-shaped: no secret data (is kvVersion 2 correct?)',
    )
  })

  it('accepts a custom fetch', async () => {
    const calls: string[] = []
    const fakeFetch = ((input: string | URL | Request) => {
      calls.push(String(input))
      return Promise.resolve(Response.json({ data: { data: { CUSTOM: 'fetch' } } }))
    }) as typeof fetch
    const source = await loadConfigSource(
      [vault({ address: 'https://vault.example.com', token: TOKEN, path: 'secret/app', fetch: fakeFetch })],
      { env: {} },
    )
    expect(source.get('CUSTOM')).toBe('fetch')
    expect(calls).toEqual(['https://vault.example.com/v1/secret/data/app'])
  })

  it('validates its options when configured', async () => {
    const cases: unknown[] = [
      {},
      { path: '' },
      { path: [] },
      { path: 'nomount' },
      { path: 'secret/' },
      { path: 'secret/app', kvVersion: 3 },
    ]
    for (const options of cases) {
      const error = await caught(() => vault(options as never))
      expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
    }
  })
})
