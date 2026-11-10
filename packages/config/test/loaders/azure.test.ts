/** `azureKeyVault()` specifics; the common secret-loader contract is in secret-stores.test.ts. */
import type { SecretClient } from '@azure/keyvault-secrets'
import type { KeyVaultSecretClientLike } from '../../src/index.ts'

import { ErrorCode, type ZnightError } from '@znight/core'

import { azureKeyVault, azureSecretKey, ConfigLoaderError, inline, loadConfigSource } from '../../src/index.ts'
import { caught } from '../helpers.ts'
import { describe, expect, it } from 'bun:test'

const VAULT_URL = 'https://acme.vault.azure.net'

interface Call {
  name: string
  version: string | undefined
  signal: boolean
}

function fakeClient(calls: Call[] = [], values: Record<string, string> = {}): KeyVaultSecretClientLike {
  return {
    getSecret: async (name, options) => {
      calls.push({ name, version: options?.version, signal: options?.abortSignal instanceof AbortSignal })
      await Promise.resolve()
      const value = values[name] ?? `value-of-${name}`
      return { name, value }
    },
  }
}

function restError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'RestError', statusCode, code })
}

describe('azureKeyVault()', () => {
  it('maps secret names to config keys: "-" to "_", "--" to "."', async () => {
    expect(azureSecretKey('DB-PASSWORD')).toBe('DB_PASSWORD')
    expect(azureSecretKey('database--password')).toBe('database.password')
    expect(azureSecretKey('mail--smtp-host')).toBe('mail.smtp_host')
    const source = await loadConfigSource(
      [azureKeyVault({ vaultUrl: VAULT_URL, secretId: ['DB-PASSWORD', 'database--password'], client: fakeClient() })],
      { env: {} },
    )
    expect(source.get('DB_PASSWORD')).toBe('value-of-DB-PASSWORD')
    expect(source.get('database.password')).toBe('value-of-database--password')
    expect(source.origin('DB_PASSWORD')).toBe('azure-key-vault:DB-PASSWORD')
  })

  it('reads a version and passes an abort signal', async () => {
    const calls: Call[] = []
    await loadConfigSource(
      [
        azureKeyVault({
          secretId: [{ secretId: 'API-KEY', version: '0123456789abcdef0123456789abcdef' }, 'DB-PASSWORD'],
          client: fakeClient(calls),
        }),
      ],
      { env: {} },
    )
    expect(calls.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'API-KEY', version: '0123456789abcdef0123456789abcdef', signal: true },
      { name: 'DB-PASSWORD', version: undefined, signal: true },
    ])
  })

  it('needs a vault URL for the default client: option, previous loaders or AZURE_KEY_VAULT_URL', async () => {
    const missing = await caught(() => loadConfigSource([azureKeyVault({ secretId: 'DB-PASSWORD' })], { env: {} }))
    expect(missing).toBeInstanceOf(ConfigLoaderError)
    expect(missing.message).toContain('no vault URL: pass { vaultUrl } or set AZURE_KEY_VAULT_URL')
    const invalid = await caught(() =>
      loadConfigSource([inline({ AZURE_KEY_VAULT_URL: 'not a url' }), azureKeyVault({ secretId: 'DB-PASSWORD' })], {
        env: {},
      }),
    )
    expect(invalid.message).toContain('invalid vault URL "not a url"')
  })

  it('explains permission and credential errors', async () => {
    const failing = (error: Error) =>
      loadConfigSource(
        [azureKeyVault({ secretId: 'DB-PASSWORD', client: { getSecret: () => Promise.reject(error) } })],
        { env: {} },
      )
    const forbidden = await caught(() =>
      failing(restError(403, 'Forbidden', 'The user does not have secrets get permission.')),
    )
    expect(forbidden.message).toContain(
      'cannot read secret "DB-PASSWORD": Forbidden: The user does not have secrets get permission.',
    )
    expect((forbidden as ZnightError).hints.join('\n')).toContain('Key Vault Secrets User')
    const notFound = await caught(() => failing(restError(404, 'SecretNotFound', 'not found')))
    expect((notFound as ZnightError).hints.join('\n')).toContain('optional')
    const credentials = Object.assign(new Error('DefaultAzureCredential failed to retrieve a token'), {
      name: 'AggregateAuthenticationError',
    })
    const noCredentials = await caught(() => failing(credentials))
    expect(noCredentials.message).toContain('AggregateAuthenticationError: DefaultAzureCredential failed')
    expect((noCredentials as ZnightError).hints.join('\n')).toContain('az login')
  })

  it('validates its options when configured', async () => {
    const cases: unknown[] = [
      undefined,
      {},
      { secretId: [] },
      { secretId: 'DB_PASSWORD' },
      { secretId: 'a'.repeat(128) },
      { secretId: { secretId: 'X', version: 'v-1' } },
      { secretId: 'X', client: {} },
      { secretId: 'X', credential: 'token' },
      { secretId: 'X', timeoutMs: 0 },
    ]
    for (const options of cases) {
      const error = await caught(() => azureKeyVault(options as never))
      expect([options, (error as ZnightError).code]).toEqual([options, ErrorCode.InvalidConfig])
    }
    const underscore = await caught(() => azureKeyVault({ secretId: 'DB_PASSWORD' }))
    expect((underscore as ZnightError).hints.join('\n')).toContain('DB-PASSWORD for the key DB_PASSWORD')
  })

  it('the SDK client is assignable to KeyVaultSecretClientLike', () => {
    const assignable = (client: SecretClient): KeyVaultSecretClientLike => client
    expect(assignable).toBeFunction()
  })
})

/** Minimal `HttpHeaders` of `@azure/core-rest-pipeline`. */
function headers(values: Record<string, string>) {
  const map = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]))
  return {
    get: (name: string) => map.get(name.toLowerCase()),
    has: (name: string) => map.has(name.toLowerCase()),
    set: (name: string, value: string) => map.set(name.toLowerCase(), value),
    delete: (name: string) => map.delete(name.toLowerCase()),
    toJSON: () => Object.fromEntries(map),
    [Symbol.iterator]: () => map.entries(),
  }
}

describe('azureKeyVault() with the Azure SDK', () => {
  interface Request {
    url: string
    authorization: string | undefined
  }

  /** A Key Vault answering the authentication challenge, then the secrets (no network). */
  function fakeVault(requests: Request[]) {
    return {
      sendRequest: (request: { url: string; headers: { get(name: string): string | undefined } }) => {
        const authorization = request.headers.get('authorization')
        requests.push({ url: request.url, authorization })
        const respond = (status: number, body: unknown, extra: Record<string, string> = {}) =>
          Promise.resolve({
            request,
            status,
            headers: headers({ 'content-type': 'application/json', ...extra }),
            bodyAsText: JSON.stringify(body),
          })
        if (authorization === undefined) {
          return respond(
            401,
            {},
            {
              'www-authenticate':
                'Bearer authorization="https://login.microsoftonline.com/tenant-id", resource="https://vault.azure.net"',
            },
          )
        }
        const name = /\/secrets\/([^/?]+)/.exec(new URL(request.url).pathname)?.[1] ?? ''
        if (name === 'MISSING') {
          return respond(404, {
            error: {
              code: 'SecretNotFound',
              message: `A secret with (name/id) ${name} was not found in this key vault.`,
            },
          })
        }
        return respond(200, {
          value: `value-of-${name}`,
          id: `${VAULT_URL}/secrets/${name}/0123456789abcdef0123456789abcdef`,
          attributes: { enabled: true },
        })
      },
    }
  }

  const credential = {
    getToken: () => Promise.resolve({ token: 'test-token', expiresOnTimestamp: Date.now() + 3_600_000 }),
  }

  it('creates a SecretClient with the credential and reads the secrets', async () => {
    const requests: Request[] = []
    const source = await loadConfigSource(
      [
        inline({ AZURE_KEY_VAULT_URL: VAULT_URL }),
        azureKeyVault({
          secretId: ['DB-PASSWORD', 'MISSING'],
          optional: true,
          credential,
          clientConfig: { httpClient: fakeVault(requests), retryOptions: { maxRetries: 0 } },
        }),
      ],
      { env: {} },
    )
    expect(source.get('DB_PASSWORD')).toBe('value-of-DB-PASSWORD')
    expect(source.has('MISSING')).toBe(false)
    expect(requests.some(request => request.authorization === 'Bearer test-token')).toBe(true)
    expect(requests.every(request => request.url.startsWith(`${VAULT_URL}/secrets/`))).toBe(true)
  })

  it('maps SDK errors', async () => {
    const error = await caught(() =>
      loadConfigSource(
        [
          azureKeyVault({
            vaultUrl: VAULT_URL,
            secretId: 'MISSING',
            credential,
            clientConfig: { httpClient: fakeVault([]), retryOptions: { maxRetries: 0 } },
          }),
        ],
        { env: {} },
      ),
    )
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('cannot read secret "MISSING": SecretNotFound: A secret with (name/id) MISSING')
  })
})
