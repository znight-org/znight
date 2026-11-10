import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import type { AccessSecretVersionResponseLike, SecretManagerServiceClientLike } from '../../src/index.ts'

import { createServer } from 'node:http'
import { inspect } from 'node:util'
import { ErrorCode, type ZnightError } from '@znight/core'

import {
  ConfigLoaderError,
  gcpSecretManager,
  inline,
  loadConfig,
  loadConfigSource,
  resolveFields,
  SECRET_MASK,
} from '../../src/index.ts'
import { caught, field } from '../helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

/** A gRPC-like error, as google-gax rejects with. */
class GrpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

const PROJECT = 'acme-prod'

/** Secrets of the fake project, by short id. */
const SECRETS: Record<string, { value?: string | Uint8Array }> = {
  DB_PASSWORD: { value: 'db-password' },
  PROD_API_TOKEN: { value: new TextEncoder().encode('token-bytes') },
  PROD_DB_PASSWORD: { value: 'prod-db-password' },
  APP_JSON: { value: JSON.stringify({ SMTP_PASSWORD: 'smtp', mail: { user: 'bot' } }) },
  NOT_JSON: { value: '{not json' },
  SERVICE_ACCOUNT: { value: '{"type":"service_account","private_key":"-----BEGIN"}' },
  EMPTY: {},
}

interface Calls {
  access: { name: string; options: unknown }[]
}

function fakeClient(calls: Calls = { access: [] }): SecretManagerServiceClientLike {
  return {
    accessSecretVersion: async (request, options) => {
      calls.access.push({ name: request.name, options })
      await Promise.resolve()
      const match = /^projects\/([^/]+)\/(?:locations\/[^/]+\/)?secrets\/([^/]+)\/versions\/([^/]+)$/.exec(request.name)
      if (match === null) throw new GrpcError(3, `3 INVALID_ARGUMENT: invalid resource name ${request.name}`)
      const [, projectId, id = '', version] = match
      if (id === 'DENIED') {
        throw new GrpcError(
          7,
          `7 PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied for resource '${request.name}' (or it may not exist).`,
        )
      }
      if (id === 'DISABLED') throw new GrpcError(9, `9 FAILED_PRECONDITION: ${request.name} is in DISABLED state.`)
      const secret = SECRETS[id]
      if ((projectId !== PROJECT && projectId !== '123456') || secret === undefined || version === '404') {
        throw new GrpcError(5, `5 NOT_FOUND: Secret [${request.name}] not found or has no versions.`)
      }
      const response: AccessSecretVersionResponseLike = {
        name: request.name.replace(/latest$/, '7'),
        payload: secret.value === undefined ? null : { data: secret.value },
      }
      return [response, undefined, undefined]
    },
  }
}

const load = (options: Parameters<typeof gcpSecretManager>[0], env: Record<string, string> = {}) =>
  loadConfigSource([gcpSecretManager(options)], { env })

describe('gcpSecretManager() by name', () => {
  it('reads secrets by id, version "latest", under their id', async () => {
    const calls: Calls = { access: [] }
    const source = await load({
      projectId: PROJECT,
      secretId: ['DB_PASSWORD', 'PROD_API_TOKEN'],
      client: fakeClient(calls),
    })
    expect(source.get('DB_PASSWORD')).toBe('db-password')
    expect(source.get('PROD_API_TOKEN')).toBe('token-bytes')
    expect(source.origin('DB_PASSWORD')).toBe('gcp-secret-manager:DB_PASSWORD')
    expect(calls.access.map(call => call.name).sort()).toEqual([
      'projects/acme-prod/secrets/DB_PASSWORD/versions/latest',
      'projects/acme-prod/secrets/PROD_API_TOKEN/versions/latest',
    ])
    expect(calls.access[0]?.options).toEqual({ timeout: 10_000 })
  })

  it('accepts refs with a key, a version, or a full resource name', async () => {
    const calls: Calls = { access: [] }
    const ok = await load({
      projectId: PROJECT,
      secretId: [
        { secretId: 'DB_PASSWORD', key: 'database.password', version: '3' },
        { secretId: 'PROD_API_TOKEN', version: '12' },
        { secretId: 'projects/123456/secrets/PROD_DB_PASSWORD/versions/5', key: 'PINNED' },
      ],
      client: fakeClient(calls),
    })
    expect(ok.get('database.password')).toBe('db-password')
    expect(ok.get('PROD_API_TOKEN')).toBe('token-bytes')
    expect(ok.get('PINNED')).toBe('prod-db-password')
    expect(calls.access.map(call => call.name)).toContain('projects/acme-prod/secrets/DB_PASSWORD/versions/3')
    expect(calls.access.map(call => call.name)).toContain('projects/acme-prod/secrets/PROD_API_TOKEN/versions/12')
    expect(calls.access.map(call => call.name)).toContain('projects/123456/secrets/PROD_DB_PASSWORD/versions/5')
  })

  it('reads the project from previous loaders, the environment, then the client', async () => {
    const calls: Calls = { access: [] }
    const fromLoaders = await loadConfigSource(
      [
        inline({ GOOGLE_CLOUD_PROJECT: PROJECT }),
        gcpSecretManager({ secretId: 'DB_PASSWORD', client: fakeClient(calls) }),
      ],
      { env: { GOOGLE_CLOUD_PROJECT: 'ignored' } },
    )
    expect(fromLoaders.get('DB_PASSWORD')).toBe('db-password')
    const fromEnv = await load({ secretId: 'DB_PASSWORD', client: fakeClient(calls) }, { GCLOUD_PROJECT: PROJECT })
    expect(fromEnv.get('DB_PASSWORD')).toBe('db-password')
    const fromClient = await load({
      secretId: 'DB_PASSWORD',
      client: { ...fakeClient(calls), getProjectId: () => Promise.resolve(PROJECT) },
    })
    expect(fromClient.get('DB_PASSWORD')).toBe('db-password')
    expect(new Set(calls.access.map(call => call.name))).toEqual(
      new Set(['projects/acme-prod/secrets/DB_PASSWORD/versions/latest']),
    )
  })

  it('fails when the project cannot be determined', async () => {
    const error = await caught(() => load({ secretId: 'DB_PASSWORD', client: fakeClient() }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toBe(
      'ZNIGHT006: Config loader "gcp-secret-manager" failed: cannot determine the Google Cloud project',
    )
    expect((error as ZnightError).hints.join('\n')).toContain('GOOGLE_CLOUD_PROJECT')
    const failing = await caught(() =>
      load({
        secretId: 'DB_PASSWORD',
        client: { ...fakeClient(), getProjectId: () => Promise.reject(new Error('metadata server unreachable')) },
      }),
    )
    expect(failing.message).toContain('cannot determine the Google Cloud project: metadata server unreachable')
  })

  it('does not need a project for full resource names', async () => {
    const source = await load({ secretId: 'projects/acme-prod/secrets/DB_PASSWORD', client: fakeClient() })
    expect(source.get('DB_PASSWORD')).toBe('db-password')
    expect(source.origin('DB_PASSWORD')).toBe('gcp-secret-manager:projects/acme-prod/secrets/DB_PASSWORD')
  })

  it('uses regional resource names with a location', async () => {
    const calls: Calls = { access: [] }
    await load({
      projectId: PROJECT,
      location: 'europe-west1',
      secretId: 'DB_PASSWORD',
      client: fakeClient(calls),
    })
    expect(calls.access.map(call => call.name)).toEqual([
      'projects/acme-prod/locations/europe-west1/secrets/DB_PASSWORD/versions/latest',
    ])
  })

  it('reads regional resource names of its location', async () => {
    const calls: Calls = { access: [] }
    const source = await load({
      location: 'europe-west1',
      secretId: 'projects/acme-prod/locations/europe-west1/secrets/DB_PASSWORD/versions/2',
      client: fakeClient(calls),
    })
    expect(source.get('DB_PASSWORD')).toBe('db-password')
    expect(calls.access.map(call => call.name)).toEqual([
      'projects/acme-prod/locations/europe-west1/secrets/DB_PASSWORD/versions/2',
    ])
  })

  it('rejects resource names outside its location, which its endpoint cannot serve', async () => {
    const regionalWithoutLocation = await caught(() =>
      gcpSecretManager({ secretId: 'projects/acme-prod/locations/europe-west1/secrets/DB_PASSWORD' }),
    )
    expect((regionalWithoutLocation as ZnightError).code).toBe(ErrorCode.InvalidConfig)
    expect(regionalWithoutLocation.message).toContain(
      'secret "projects/acme-prod/locations/europe-west1/secrets/DB_PASSWORD" is not in the loader\'s location: it reads global secrets',
    )
    expect((regionalWithoutLocation as ZnightError).hints.join('\n')).toContain(
      "Set location: 'europe-west1' (endpoint secretmanager.europe-west1.rep.googleapis.com)",
    )

    const globalWithLocation = await caught(() =>
      gcpSecretManager({ location: 'europe-west1', secretId: ['DB_PASSWORD', 'projects/acme-prod/secrets/API_KEY'] }),
    )
    expect((globalWithLocation as ZnightError).code).toBe(ErrorCode.InvalidConfig)
    expect(globalWithLocation.message).toContain('it reads secrets of location "europe-west1"')
    expect((globalWithLocation as ZnightError).hints.join('\n')).toContain('Remove "location"')

    const otherLocation = await caught(() =>
      gcpSecretManager({
        location: 'europe-west1',
        secretId: { secretId: 'projects/acme-prod/locations/us-east1/secrets/DB_PASSWORD', optional: true },
      }),
    )
    expect((otherLocation as ZnightError).code).toBe(ErrorCode.InvalidConfig)
    expect((otherLocation as ZnightError).hints.join('\n')).toContain("Set location: 'us-east1'")
  })

  it('later secrets override earlier ones', async () => {
    const source = await load({
      projectId: PROJECT,
      secretId: ['DB_PASSWORD', { secretId: 'PROD_DB_PASSWORD', key: 'DB_PASSWORD' }],
      client: fakeClient(),
    })
    expect(source.get('DB_PASSWORD')).toBe('prod-db-password')
  })
})

describe('gcpSecretManager() values', () => {
  it('expands JSON object secrets into one value per entry, like the other secret loaders', async () => {
    const source = await load({ projectId: PROJECT, secretId: ['APP_JSON', 'NOT_JSON'], client: fakeClient() })
    expect(source.get('SMTP_PASSWORD')).toBe('smtp')
    expect(source.get('mail.user')).toBe('bot')
    expect(source.origin('SMTP_PASSWORD')).toBe('gcp-secret-manager:APP_JSON')
    expect(source.get('NOT_JSON')).toBe('{not json')
    const nested = await load({
      projectId: PROJECT,
      secretId: { secretId: 'APP_JSON', key: 'app' },
      client: fakeClient(),
    })
    expect(nested.get('app.SMTP_PASSWORD')).toBe('smtp')
  })

  it('keeps JSON values as text with json: false (globally or per secret)', async () => {
    const global = await load({
      projectId: PROJECT,
      secretId: ['APP_JSON', 'SERVICE_ACCOUNT'],
      json: false,
      client: fakeClient(),
    })
    expect(global.get('APP_JSON')).toBe(SECRETS.APP_JSON?.value as string)
    expect(global.has('SMTP_PASSWORD')).toBe(false)
    const perSecret = await load({
      projectId: PROJECT,
      secretId: ['APP_JSON', { secretId: 'SERVICE_ACCOUNT', json: false }],
      client: fakeClient(),
    })
    expect(perSecret.get('SMTP_PASSWORD')).toBe('smtp')
    expect(perSecret.get('SERVICE_ACCOUNT')).toBe('{"type":"service_account","private_key":"-----BEGIN"}')
  })

  it('marks its values as secretId: masked in validation messages', async () => {
    const source = await load({
      projectId: PROJECT,
      secretId: { secretId: 'DB_PASSWORD', key: 'PORT' },
      client: fakeClient(),
    })
    const { problems } = resolveFields('ServerConfig', [field('port', 'number')], source)
    expect(problems[0]?.message).toBe('expected a number but got [REDACTED]')
    expect(problems[0]?.origin).toBe('gcp-secret-manager:DB_PASSWORD')
  })

  it('marks its values as secretId: masked when a config instance is printed, without @Secret', async () => {
    class Db {
      dbPassword!: string
    }
    const loaded = await loadConfigSource([
      gcpSecretManager({ projectId: PROJECT, secretId: 'DB_PASSWORD', client: fakeClient() }),
    ])
    const db = loadConfig(Db, loaded, [field('dbPassword')])
    expect(db.dbPassword).toBe('db-password')
    expect(JSON.stringify(db)).toBe(`{"dbPassword":"${SECRET_MASK}"}`)
    expect(inspect(db)).toBe(`Db { dbPassword: '${SECRET_MASK}' }`)
  })

  it('reports secrets without value', async () => {
    const error = await caught(() => load({ projectId: PROJECT, secretId: 'EMPTY', client: fakeClient() }))
    expect(error.message).toContain('secret "EMPTY" has no value')
  })
})

describe('gcpSecretManager() errors', () => {
  it('fails on missing secrets unless optional (per secret or globally)', async () => {
    const error = await caught(() => load({ projectId: PROJECT, secretId: 'UNKNOWN', client: fakeClient() }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toBe(
      'ZNIGHT006: Config loader "gcp-secret-manager" failed: cannot read secret "UNKNOWN": NOT_FOUND: Secret [projects/acme-prod/secrets/UNKNOWN/versions/latest] not found or has no versions.',
    )
    expect((error.cause as GrpcError).code).toBe(5)
    expect((error as ZnightError).hints.join('\n')).toContain('optional')
    const perSecret = await load({
      projectId: PROJECT,
      secretId: [{ secretId: 'UNKNOWN', optional: true }, 'DB_PASSWORD'],
      client: fakeClient(),
    })
    expect(perSecret.keys()).toEqual(['DB_PASSWORD'])
    const global = await load({ projectId: PROJECT, secretId: ['UNKNOWN'], optional: true, client: fakeClient() })
    expect(global.keys()).toEqual([])
  })

  it('never skips other errors, even when optional, and explains permissions', async () => {
    const error = await caught(() =>
      load({ projectId: PROJECT, secretId: 'DENIED', optional: true, client: fakeClient() }),
    )
    expect(error.message).toContain(
      'cannot read secret "DENIED": PERMISSION_DENIED: Permission \'secretmanager.versions.access\' denied',
    )
    expect((error as ZnightError).hints.join('\n')).toContain('roles/secretmanager.secretAccessor')
    const disabled = await caught(() => load({ projectId: PROJECT, secretId: 'DISABLED', client: fakeClient() }))
    expect(disabled.message).toContain('cannot read secret "DISABLED": FAILED_PRECONDITION:')
    expect((disabled as ZnightError).hints.join('\n')).toContain('disabled or destroyed')
  })

  it('explains missing credentials', async () => {
    const client: SecretManagerServiceClientLike = {
      accessSecretVersion: () =>
        Promise.reject(
          new Error(
            'Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.',
          ),
        ),
    }
    const error = await caught(() => load({ projectId: PROJECT, secretId: 'DB_PASSWORD', client }))
    expect(error.message).toContain('cannot read secret "DB_PASSWORD": Could not load the default credentials.')
    expect((error as ZnightError).hints.join('\n')).toContain('gcloud auth application-default login')
    const unauthenticated = await caught(() =>
      load({
        projectId: PROJECT,
        secretId: 'DB_PASSWORD',
        client: { accessSecretVersion: () => Promise.reject(new GrpcError(16, '16 UNAUTHENTICATED: bad token')) },
      }),
    )
    expect(unauthenticated.message).toContain('UNAUTHENTICATED: bad token')
    expect((unauthenticated as ZnightError).hints.join('\n')).toContain('gcloud auth application-default login')
  })

  it('times out hanging requests', async () => {
    const client: SecretManagerServiceClientLike = { accessSecretVersion: () => new Promise(() => {}) }
    const error = await caught(() => load({ projectId: PROJECT, secretId: 'DB_PASSWORD', client, timeoutMs: 20 }))
    expect(error.message).toBe(
      'ZNIGHT006: Config loader "gcp-secret-manager" failed: cannot read secret "DB_PASSWORD": timed out after 20 ms',
    )
  })

  it('stops waiting for the other secrets once one failed', async () => {
    const client: SecretManagerServiceClientLike = {
      accessSecretVersion: request =>
        request.name.includes('DENIED')
          ? Promise.reject(new GrpcError(7, '7 PERMISSION_DENIED: denied'))
          : new Promise(() => {}),
    }
    const started = Date.now()
    const error = await caught(() =>
      load({ projectId: PROJECT, secretId: ['HANGING', 'DENIED'], client, timeoutMs: 60_000 }),
    )
    expect(error.message).toContain('PERMISSION_DENIED: denied')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('does not close injected clients', async () => {
    let closed = false
    const client = {
      ...fakeClient(),
      close: () => {
        closed = true
        return Promise.resolve()
      },
    }
    await load({ projectId: PROJECT, secretId: 'DB_PASSWORD', client })
    expect(closed).toBe(false)
  })

  it('validates its options when configured', async () => {
    const cases: unknown[] = [
      undefined,
      {},
      { secretId: [] },
      { secretId: '' },
      { secretId: 'a/b' },
      { secretId: 'projects/p/secrets/' },
      { secretId: [{ key: 'x' }] },
      { secretId: { secretId: 'X', version: '' } },
      { secretId: 'X', projectId: '' },
      { secretId: 'X', location: 'a/b' },
      { secretId: 'X', client: {} },
      { secretId: 'X', json: 'yes' },
      { secretId: { secretId: 'X', optional: 1 } },
      { secretId: { secretId: 'X', key: '' } },
      { labels: { app: 'api' } },
    ]
    for (const options of cases) {
      const error = await caught(() => gcpSecretManager(options as never))
      expect([options, (error as ZnightError).code]).toEqual([options, ErrorCode.InvalidConfig])
    }
    for (const timeoutMs of [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY, 2 ** 31]) {
      const error = await caught(() => gcpSecretManager({ secretId: 'x', timeoutMs }))
      expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
      expect(error.message).toContain('timeoutMs')
    }
  })

  it('the SDK client is assignable to SecretManagerServiceClientLike', () => {
    const assignable = (client: SecretManagerServiceClient): SecretManagerServiceClientLike => client
    expect(assignable).toBeFunction()
  })
})

describe('gcpSecretManager() with the Google Cloud SDK', () => {
  let server: Server
  let port: number
  const requests: {
    method: string | undefined
    url: string
    authorization: string | undefined
  }[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      requests.push({
        method: req.method,
        url: url.pathname,
        authorization: req.headers.authorization,
      })
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (url.pathname.includes('/secrets/DENIED/')) {
        json(403, {
          error: {
            code: 403,
            message: "Permission 'secretmanager.versions.access' denied",
            status: 'PERMISSION_DENIED',
          },
        })
        return
      }
      if (url.pathname.includes('/secrets/MISSING/')) {
        json(404, { error: { code: 404, message: 'Secret not found or has no versions.', status: 'NOT_FOUND' } })
        return
      }
      const id = /\/secrets\/([^/]+)\/versions\/latest:access$/.exec(url.pathname)?.[1] ?? 'unknown'
      json(200, {
        name: `projects/123456/secrets/${id}/versions/1`,
        payload: { data: Buffer.from(`value-of-${id}`).toString('base64') },
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  // REST transport against the local fake endpoint, with a fake auth client (no Google credentials)
  const clientConfig = () => ({
    fallback: true,
    protocol: 'http',
    apiEndpoint: '127.0.0.1',
    port,
    authClient: {
      getRequestHeaders: () => Promise.resolve(new Headers({ authorization: 'Bearer test-token' })),
      fetch: (url: string, init: RequestInit) =>
        fetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), authorization: 'Bearer test-token' },
        }),
    },
  })

  it('creates a SecretManagerServiceClient and accesses the versions', async () => {
    const source = await load({
      projectId: PROJECT,
      secretId: ['DB_PASSWORD', 'projects/123456/secrets/PROD_DB_PASSWORD', 'MISSING'],
      optional: true,
      clientConfig: clientConfig(),
    })
    expect(source.get('PROD_DB_PASSWORD')).toBe('value-of-PROD_DB_PASSWORD')
    expect(source.get('DB_PASSWORD')).toBe('value-of-DB_PASSWORD')
    expect(source.has('MISSING')).toBe(false)
    expect(requests.map(request => request.url).sort()).toEqual([
      '/v1/projects/123456/secrets/PROD_DB_PASSWORD/versions/latest:access',
      '/v1/projects/acme-prod/secrets/DB_PASSWORD/versions/latest:access',
      '/v1/projects/acme-prod/secrets/MISSING/versions/latest:access',
    ])
    expect(requests.every(request => request.method === 'GET' && request.authorization === 'Bearer test-token')).toBe(
      true,
    )
  })

  it('sends the requests of a location to its regional endpoint', async () => {
    const urls: string[] = []
    const options = clientConfig()
    const { apiEndpoint: _endpoint, port: _port, ...regional } = options
    await load({
      projectId: PROJECT,
      location: 'europe-west1',
      secretId: ['DB_PASSWORD', 'projects/acme-prod/locations/europe-west1/secrets/API_KEY'],
      clientConfig: {
        ...regional,
        authClient: {
          ...options.authClient,
          // records the URL the SDK built, then sends the request to the local server
          fetch: (url: string, init: RequestInit) => {
            urls.push(url)
            const local = new URL(url)
            local.protocol = 'http:'
            local.host = `127.0.0.1:${port}`
            return options.authClient.fetch(local.href, init)
          },
        },
      },
    })
    expect(urls.map(url => new URL(url).hostname)).toEqual([
      'secretmanager.europe-west1.rep.googleapis.com',
      'secretmanager.europe-west1.rep.googleapis.com',
    ])
    expect(urls.map(url => new URL(url).pathname).sort()).toEqual([
      '/v1/projects/acme-prod/locations/europe-west1/secrets/API_KEY/versions/latest:access',
      '/v1/projects/acme-prod/locations/europe-west1/secrets/DB_PASSWORD/versions/latest:access',
    ])
  })

  it('maps SDK errors', async () => {
    const error = await caught(() => load({ projectId: PROJECT, secretId: 'DENIED', clientConfig: clientConfig() }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain(
      'cannot read secret "DENIED": PERMISSION_DENIED: Permission \'secretmanager.versions.access\' denied',
    )
    expect((error as ZnightError).hints.join('\n')).toContain('roles/secretmanager.secretAccessor')
  })
})
