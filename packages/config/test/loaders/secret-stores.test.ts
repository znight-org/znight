/**
 * The common contract of the secret-store loaders (RFC 0013): the same scenarios run against
 * `vault()`, `awsSecretsManager()`, `gcpSecretManager()`, `azureKeyVault()` and `ociVault()`, each
 * with a fake client (or `fetch`) serving the same secrets.
 */
import type { ConfigLayer, ConfigLoader } from '../../src/index.ts'

import { ErrorCode, type ZnightError } from '@znight/core'

import {
  awsSecretsManager,
  azureKeyVault,
  ConfigLoaderError,
  createConfigSource,
  gcpSecretManager,
  loadConfigSource,
  ociVault,
  resolveFields,
  vault,
} from '../../src/index.ts'
import { caught, field } from '../helpers.ts'
import { describe, expect, it, spyOn } from 'bun:test'

/** The secrets every fake store serves, by logical name (`null`: a secret without value). */
const VALUES: Readonly<Record<string, string | null>> = {
  app: JSON.stringify({ DB_PASSWORD: 'app-password', database: { host: 'db-host' } }),
  override: JSON.stringify({ DB_PASSWORD: 'override-password' }),
  'DB-PASSWORD': 'plain-password',
  array: '["a"]',
  braces: '{not json',
  empty: null,
}

interface FakeStore {
  /** Logical names requested, in order. */
  readonly requests: string[]
}

interface ProviderErrors {
  notFound(name: string): Error
  denied(name: string): Error
}

/**
 * What every fake does for a logical name: `hang` never answers (unless `signal` aborts), `denied`
 * fails with a permission error, an unknown name with a not-found error.
 */
async function lookup(
  store: FakeStore,
  name: string,
  signal: AbortSignal | undefined,
  errors: ProviderErrors,
): Promise<string | null> {
  store.requests.push(name)
  await Promise.resolve()
  if (name === 'hang') {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
    })
  }
  if (name === 'denied') throw errors.denied(name)
  const value = VALUES[name]
  if (value === undefined) throw errors.notFound(name)
  return value
}

/** An error carrying extra properties (`name`, `code`, `statusCode`...), like the SDKs throw. */
function sdkError(message: string, properties: Record<string, unknown>): Error {
  return Object.assign(new Error(message), properties)
}

/** A secret of {@link ContractOptions}: a logical name, or a name with the common per-secret options. */
type ContractSecret = string | { name: string; key?: string; json?: boolean; optional?: boolean }

interface ContractOptions {
  readonly secrets: readonly ContractSecret[]
  readonly optional?: boolean
  readonly timeoutMs?: number
}

interface SecretStoreCase {
  /** Loader name (`ConfigLoader.name`). */
  readonly loader: string
  /** The loader factory itself, called with arbitrary options. */
  readonly factory: (options?: unknown) => ConfigLoader
  /** Provider identifier of a logical name, as messages quote it. */
  readonly id: (name: string) => string
  /** Skipping an optional secret emits a warning (OCI: a 404 may be a missing policy). */
  readonly warnsOnSkip: boolean
  /** Origin of the layer of a logical name. */
  readonly origin: (name: string) => string
  /** Key of a plain value read without `key`. */
  readonly defaultKey: (name: string) => string
  /** The store holds plain values (Vault holds key/value maps only). */
  readonly plainValues: boolean
  create(store: FakeStore, options: ContractOptions): ConfigLoader
}

/** Maps the contract secrets to provider refs: `id` is the provider identifier of a logical name. */
function refs<R>(
  secrets: readonly ContractSecret[],
  build: (id: string, extra: { key?: string; json?: boolean; optional?: boolean }) => R,
  id: (name: string) => string,
): R[] {
  return secrets.map(secret => {
    const { name, ...extra } = typeof secret === 'string' ? { name: secret } : secret
    return build(name === '' ? '' : id(name), extra)
  })
}

const VAULT_PREFIX = '/v1/secret/data/'

const CASES: readonly SecretStoreCase[] = [
  {
    loader: 'vault',
    factory: vault as (options?: unknown) => ConfigLoader,
    id: name => `secret/${name}`,
    warnsOnSkip: false,
    origin: name => `vault:secret/${name}`,
    defaultKey: name => name,
    plainValues: false,
    create: (store, options) =>
      vault({
        address: 'http://vault.test',
        token: 'test-token',
        path: refs(
          options.secrets,
          (path, { key, optional }) => ({
            path,
            ...(key === undefined ? {} : { key }),
            ...(optional === undefined ? {} : { optional }),
          }),
          name => `secret/${name}`,
        ),
        retries: 0,
        ...(options.optional === undefined ? {} : { optional: options.optional }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input))
          const name = decodeURIComponent(url.pathname.slice(VAULT_PREFIX.length))
          const json = (status: number, body: unknown) =>
            new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
          try {
            const value = await lookup(store, name, init?.signal ?? undefined, {
              notFound: () => sdkError('404', { status: 404 }),
              denied: () => sdkError('403', { status: 403 }),
            })
            return json(200, { data: { data: value === null ? null : JSON.parse(value) } })
          } catch (error) {
            const status = (error as { status?: unknown }).status
            if (typeof status === 'number') return json(status, { errors: ['permission denied'] })
            throw error
          }
        }) as typeof fetch,
      }),
  },
  {
    loader: 'aws-secrets-manager',
    factory: awsSecretsManager as (options?: unknown) => ConfigLoader,
    id: name => `prod/${name}`,
    warnsOnSkip: false,
    origin: name => `aws-secrets-manager:prod/${name}`,
    defaultKey: name => `prod/${name}`,
    plainValues: true,
    create: (store, options) =>
      awsSecretsManager({
        secretId: refs(
          options.secrets,
          (secretId, extra) => ({ secretId, ...extra }),
          name => `prod/${name}`,
        ),
        ...(options.optional === undefined ? {} : { optional: options.optional }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        client: {
          getSecretValue: async (input, requestOptions) => {
            const value = await lookup(store, input.SecretId.slice('prod/'.length), requestOptions?.abortSignal, {
              notFound: () =>
                sdkError("Secrets Manager can't find the specified secret.", {
                  name: 'ResourceNotFoundException',
                }),
              denied: () => sdkError('not authorized', { name: 'AccessDeniedException' }),
            })
            return value === null ? {} : { SecretString: value }
          },
        },
      }),
  },
  {
    loader: 'gcp-secret-manager',
    factory: gcpSecretManager as (options?: unknown) => ConfigLoader,
    id: name => name,
    warnsOnSkip: false,
    origin: name => `gcp-secret-manager:${name}`,
    defaultKey: name => name,
    plainValues: true,
    create: (store, options) =>
      gcpSecretManager({
        projectId: 'acme-prod',
        secretId: refs(
          options.secrets,
          (secretId, extra) => ({ secretId, ...extra }),
          name => name,
        ),
        ...(options.optional === undefined ? {} : { optional: options.optional }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        client: {
          accessSecretVersion: async request => {
            const name = /\/secrets\/([^/]+)\/versions\//.exec(request.name)?.[1] ?? ''
            const value = await lookup(store, name, undefined, {
              notFound: () =>
                sdkError(`5 NOT_FOUND: Secret [${request.name}] not found or has no versions.`, { code: 5 }),
              denied: () =>
                sdkError("7 PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied", { code: 7 }),
            })
            return [{ name: request.name, payload: value === null ? null : { data: new TextEncoder().encode(value) } }]
          },
        },
      }),
  },
  {
    loader: 'azure-key-vault',
    factory: azureKeyVault as (options?: unknown) => ConfigLoader,
    id: name => name,
    warnsOnSkip: false,
    origin: name => `azure-key-vault:${name}`,
    defaultKey: name => name.replaceAll('--', '.').replaceAll('-', '_'),
    plainValues: true,
    create: (store, options) =>
      azureKeyVault({
        vaultUrl: 'https://acme.vault.azure.net',
        secretId: refs(
          options.secrets,
          (secretId, extra) => ({ secretId, ...extra }),
          name => name,
        ),
        ...(options.optional === undefined ? {} : { optional: options.optional }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        client: {
          getSecret: async (name, requestOptions) => {
            const value = await lookup(store, name, requestOptions?.abortSignal, {
              notFound: () =>
                sdkError(`A secret with (name/id) ${name} was not found in this key vault.`, {
                  name: 'RestError',
                  statusCode: 404,
                  code: 'SecretNotFound',
                }),
              denied: () =>
                sdkError('The user does not have secrets get permission.', {
                  name: 'RestError',
                  statusCode: 403,
                  code: 'Forbidden',
                }),
            })
            return { name, properties: {}, ...(value === null ? {} : { value }) }
          },
        },
      }),
  },
  {
    loader: 'oci-vault',
    factory: ociVault as (options?: unknown) => ConfigLoader,
    id: name => name,
    warnsOnSkip: true,
    origin: name => `oci-vault:${name}`,
    defaultKey: name => name,
    plainValues: true,
    create: (store, options) =>
      ociVault({
        vaultId: 'ocid1.vault.oc1.eu-frankfurt-1.test',
        secretId: refs(
          options.secrets,
          (secretId, extra) => ({ secretId, ...extra }),
          name => name,
        ),
        ...(options.optional === undefined ? {} : { optional: options.optional }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        client: {
          getSecretBundle: () => Promise.reject(new Error('unexpected getSecretBundle call')),
          getSecretBundleByName: async request => {
            const value = await lookup(store, request.secretName, undefined, {
              notFound: () =>
                sdkError('Authorization failed or requested resource not found.', {
                  statusCode: 404,
                  serviceCode: 'NotAuthorizedOrNotFound',
                }),
              denied: () =>
                sdkError('The required information to complete authentication was not provided.', {
                  statusCode: 401,
                  serviceCode: 'NotAuthenticated',
                }),
            })
            return {
              secretBundle: {
                secretId: `ocid1.vaultsecret.oc1.test.${request.secretName}`,
                versionNumber: 1,
                ...(value === null
                  ? {}
                  : { secretBundleContent: { contentType: 'BASE64', content: Buffer.from(value).toString('base64') } }),
              },
            }
          },
        },
      }),
  },
]

async function layers(loader: ConfigLoader): Promise<ConfigLayer[]> {
  const result = await loader.load({ cwd: process.cwd(), env: {}, source: createConfigSource([]) })
  return result === undefined ? [] : [result].flat()
}

describe.each(CASES)('secret-store contract: $loader', store => {
  const create = (options: ContractOptions, fake: FakeStore = { requests: [] }) => store.create(fake, options)
  const load = (options: ContractOptions) => loadConfigSource([create(options)], { env: {} })

  it('expands a JSON object secret into one value per entry, at the root', async () => {
    const source = await load({ secrets: ['app'] })
    expect(source.get('DB_PASSWORD')).toBe('app-password')
    expect(source.get('database.host')).toBe('db-host')
    expect(source.origin('DB_PASSWORD')).toBe(store.origin('app'))
  })

  it('flags its layers as secret: values are masked in validation messages', async () => {
    const loaded = await layers(create({ secrets: ['app'] }))
    expect(loaded).toEqual([{ origin: store.origin('app'), values: expect.any(Object), secret: true }])
    const { problems } = resolveFields('Db', [field('dbPassword', 'number')], createConfigSource(loaded))
    expect(problems[0]?.message).toBe('expected a number but got [REDACTED]')
  })

  it('mounts a JSON object secret under its key', async () => {
    const source = await load({ secrets: [{ name: 'app', key: 'primary' }] })
    expect(source.get('primary.DB_PASSWORD')).toBe('app-password')
    expect(source.get('primary.database.host')).toBe('db-host')
    expect(source.has('DB_PASSWORD')).toBe(false)
  })

  it('reads every secret, later secrets overriding earlier ones', async () => {
    const fake: FakeStore = { requests: [] }
    const source = await loadConfigSource([create({ secrets: ['app', 'override'] }, fake)], { env: {} })
    expect(source.get('DB_PASSWORD')).toBe('override-password')
    expect(source.get('database.host')).toBe('db-host')
    expect(fake.requests.sort()).toEqual(['app', 'override'])
  })

  if (store.plainValues) {
    it('stores a plain value under its key, by default derived from the secret id', async () => {
      const source = await load({ secrets: ['DB-PASSWORD', { name: 'DB-PASSWORD', key: 'db.password' }] })
      expect(source.get(store.defaultKey('DB-PASSWORD'))).toBe('plain-password')
      expect(source.get('db.password')).toBe('plain-password')
    })

    it('keeps JSON arrays, invalid JSON and, with json: false, JSON objects as text', async () => {
      const source = await load({
        secrets: [
          { name: 'array', key: 'ARRAY' },
          { name: 'braces', key: 'BRACES' },
          { name: 'app', key: 'APP', json: false },
        ],
      })
      expect(source.get('ARRAY')).toBe('["a"]')
      expect(source.get('BRACES')).toBe('{not json')
      expect(source.get('APP')).toBe(VALUES['app'] as string)
    })
  }

  it('fails on a missing secret, naming it, with a hint (ZNIGHT006)', async () => {
    const error = await caught(() => load({ secrets: ['app', 'missing'] }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect((error as ZnightError).code).toBe(ErrorCode.MissingConfig)
    expect(error.message).toContain(`"${store.loader}" failed: cannot read secret "${store.id('missing')}": `)
    expect(error.message).not.toContain('app-password')
    expect((error as ZnightError).hints.length).toBeGreaterThan(0)
  })

  it('skips a missing secret marked optional, or every missing secret with the loader option', async () => {
    const emitWarning = spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      const one = await load({ secrets: ['app', { name: 'missing', optional: true }] })
      expect(one.get('DB_PASSWORD')).toBe('app-password')
      const all = await load({ secrets: ['missing', 'app'], optional: true })
      expect(all.get('DB_PASSWORD')).toBe('app-password')
      const required = await caught(() => load({ secrets: [{ name: 'missing', optional: false }], optional: true }))
      expect(required).toBeInstanceOf(ConfigLoaderError)
      const warnings = emitWarning.mock.calls.map(call => String(call[0]))
      // one warning per skipped secret, only where a not-found answer may hide a missing policy
      expect(warnings).toHaveLength(store.warnsOnSkip ? 2 : 0)
      expect(warnings.every(warning => warning.includes(`"${store.id('missing')}"`))).toBe(true)
    } finally {
      emitWarning.mockRestore()
    }
  })

  it('reports an access error with a hint, even for an optional secret', async () => {
    const error = await caught(() => load({ secrets: [{ name: 'denied', optional: true }] }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain(`cannot read secret "${store.id('denied')}": `)
    expect((error as ZnightError).hints.length).toBeGreaterThan(0)
  })

  it('fails on a secret without value', async () => {
    const error = await caught(() => load({ secrets: ['empty'] }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain(`secret "${store.id('empty')}" has no value`)
  })

  it('gives up on a request after timeoutMs', async () => {
    const started = performance.now()
    const error = await caught(() => load({ secrets: ['app', 'hang'], timeoutMs: 50 }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain(`cannot read secret "${store.id('hang')}": timed out after 50 ms`)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('rejects invalid options when created (ZNIGHT012)', async () => {
    for (const options of [{ secrets: [] }, { secrets: ['app'], timeoutMs: 0 }, { secrets: [{ name: '' }] }]) {
      const error = await caught(() => create(options))
      expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
    }
    for (const options of [undefined, null, 'app']) {
      const error = await caught(() => store.factory(options))
      expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
      expect(error.message).toContain('options are required')
    }
  })
})
