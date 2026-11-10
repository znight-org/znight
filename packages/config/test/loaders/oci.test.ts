/** `ociVault()` specifics; the common secret-loader contract is in secret-stores.test.ts. */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SecretsClient } from 'oci-secrets'
import type { OciSecretBundleResponseLike, OciSecretsClientLike } from '../../src/index.ts'

import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { ErrorCode, type ZnightError } from '@znight/core'

import { ConfigLoaderError, inline, loadConfigSource, ociVault } from '../../src/index.ts'
import { caught, tempDir } from '../helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const VAULT = 'ocid1.vault.oc1.eu-frankfurt-1.amaaaaaatest'
const SECRET = 'ocid1.vaultsecret.oc1.eu-frankfurt-1.amaaaaaasecret'

function bundle(value: string): OciSecretBundleResponseLike {
  return {
    secretBundle: { secretBundleContent: { contentType: 'BASE64', content: Buffer.from(value).toString('base64') } },
  }
}

function fakeClient(calls: unknown[] = []): OciSecretsClientLike {
  return {
    getSecretBundle: async request => {
      calls.push({ method: 'getSecretBundle', ...request })
      await Promise.resolve()
      return bundle(`value-of-${request.secretId}`)
    },
    getSecretBundleByName: async request => {
      calls.push({ method: 'getSecretBundleByName', ...request })
      await Promise.resolve()
      return bundle(`value-of-${request.secretName}`)
    },
  }
}

describe('ociVault()', () => {
  it('reads secrets by OCID or by name in the vault, with a version number or stage', async () => {
    const calls: unknown[] = []
    const source = await loadConfigSource(
      [
        ociVault({
          vaultId: VAULT,
          secretId: [
            { secretId: SECRET, key: 'API_KEY' },
            'DB_PASSWORD',
            { secretId: 'SMTP_PASSWORD', versionNumber: 3 },
            { secretId: 'TOKEN', stage: 'PREVIOUS' },
          ],
          client: fakeClient(calls),
        }),
      ],
      { env: {} },
    )
    expect(source.get('API_KEY')).toBe(`value-of-${SECRET}`)
    expect(source.get('DB_PASSWORD')).toBe('value-of-DB_PASSWORD')
    expect(source.origin('API_KEY')).toBe(`oci-vault:${SECRET}`)
    expect(calls).toEqual([
      { method: 'getSecretBundle', secretId: SECRET },
      { method: 'getSecretBundleByName', secretName: 'DB_PASSWORD', vaultId: VAULT },
      { method: 'getSecretBundleByName', secretName: 'SMTP_PASSWORD', vaultId: VAULT, versionNumber: 3 },
      { method: 'getSecretBundleByName', secretName: 'TOKEN', vaultId: VAULT, stage: 'PREVIOUS' },
    ])
  })

  it('reads the vault from previous loaders or OCI_VAULT_ID, and needs one only for names', async () => {
    const calls: unknown[] = []
    await loadConfigSource([inline({ OCI_VAULT_ID: VAULT }), ociVault({ secretId: 'A', client: fakeClient(calls) })], {
      env: {},
    })
    await loadConfigSource([ociVault({ secretId: 'B', client: fakeClient(calls) })], { env: { OCI_VAULT_ID: VAULT } })
    expect(calls).toEqual([
      { method: 'getSecretBundleByName', secretName: 'A', vaultId: VAULT },
      { method: 'getSecretBundleByName', secretName: 'B', vaultId: VAULT },
    ])
    const byOcid = await loadConfigSource(
      [ociVault({ secretId: { secretId: SECRET, key: 'K' }, client: fakeClient() })],
      {
        env: {},
      },
    )
    expect(byOcid.get('K')).toBe(`value-of-${SECRET}`)
    const error = await caught(() => loadConfigSource([ociVault({ secretId: 'A', client: fakeClient() })], { env: {} }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('secret "A" is read by name but no vault is set')
  })

  it('explains not-found errors, which OCI also returns for missing permissions', async () => {
    const notFound = Object.assign(new Error('Authorization failed or requested resource not found.'), {
      statusCode: 404,
      serviceCode: 'NotAuthorizedOrNotFound',
    })
    const error = await caught(() =>
      loadConfigSource(
        [
          ociVault({
            secretId: SECRET,
            client: { ...fakeClient(), getSecretBundle: () => Promise.reject(notFound) },
          }),
        ],
        { env: {} },
      ),
    )
    expect(error.message).toContain(
      `cannot read secret "${SECRET}": NotAuthorizedOrNotFound (HTTP 404): Authorization failed or requested resource not found.`,
    )
    expect((error as ZnightError).hints.join('\n')).toContain('read secret-bundles')
  })

  it('selects the resource principal when OCI_RESOURCE_PRINCIPAL_VERSION is set', async () => {
    const error = await caught(() =>
      loadConfigSource([ociVault({ secretId: SECRET })], { env: { OCI_RESOURCE_PRINCIPAL_VERSION: '2.2' } }),
    )
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('cannot set up the resource-principal authentication')
  })

  it('validates its options when configured', async () => {
    const cases: unknown[] = [
      undefined,
      {},
      { secretId: [] },
      { secretId: 'a b' },
      { secretId: { secretId: 'X', versionNumber: 0 } },
      { secretId: { secretId: 'X', versionNumber: 1.5 } },
      { secretId: { secretId: 'X', stage: 'current' } },
      { secretId: 'X', auth: 'api-key' },
      { secretId: 'X', vaultId: '' },
      { secretId: 'X', profile: '' },
      { secretId: 'X', client: { getSecretBundle: () => Promise.resolve({}) } },
      { secretId: 'X', timeoutMs: 2 ** 31 },
    ]
    for (const options of cases) {
      const error = await caught(() => ociVault(options as never))
      expect([options, (error as ZnightError).code]).toEqual([options, ErrorCode.InvalidConfig])
    }
  })

  it('the SDK client is assignable to OciSecretsClientLike', () => {
    const assignable = (client: SecretsClient): OciSecretsClientLike => client
    expect(assignable).toBeFunction()
  })
})

describe('ociVault() with the OCI SDK', () => {
  let server: Server
  let endpoint: string
  const requests: { url: string; authorization: string | undefined }[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      requests.push({ url: `${url.pathname}${url.search}`, authorization: req.headers.authorization })
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json', 'opc-request-id': 'test' })
        res.end(JSON.stringify(body))
      }
      const name = url.searchParams.get('secretName') ?? url.pathname.split('/').at(-1) ?? ''
      if (name === 'MISSING') {
        json(404, { code: 'NotAuthorizedOrNotFound', message: 'Authorization failed or requested resource not found.' })
        return
      }
      json(200, {
        secretId: SECRET,
        versionNumber: 1,
        stages: ['CURRENT', 'LATEST'],
        secretBundleContent: { contentType: 'BASE64', content: Buffer.from(`value-of-${name}`).toString('base64') },
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  /** An OCI config file with a throwaway API signing key (no OCI account). */
  async function configFile() {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const dir = await tempDir({ 'key.pem': privateKey })
    const config = [
      '[TEST]',
      'user=ocid1.user.oc1..test',
      'fingerprint=aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
      'tenancy=ocid1.tenancy.oc1..test',
      'region=eu-frankfurt-1',
      `key_file=${dir.dir}/key.pem`,
      '',
    ].join('\n')
    const files = await tempDir({ config })
    return {
      path: `${files.dir}/config`,
      cleanup: () => {
        dir.cleanup()
        files.cleanup()
      },
    }
  }

  it('creates a SecretsClient from a config file profile and signs its requests', async () => {
    const config = await configFile()
    try {
      const source = await loadConfigSource(
        [
          ociVault({
            vaultId: VAULT,
            secretId: ['DB_PASSWORD', { secretId: SECRET, key: 'API_KEY' }, 'MISSING'],
            optional: true,
            auth: 'config-file',
            configFile: config.path,
            profile: 'TEST',
            endpoint,
          }),
        ],
        { env: {} },
      )
      expect(source.get('DB_PASSWORD')).toBe('value-of-DB_PASSWORD')
      expect(source.get('API_KEY')).toBe(`value-of-${SECRET}`)
      expect(source.has('MISSING')).toBe(false)
      const urls = requests.map(request => request.url).sort()
      expect(urls).toEqual([
        `/20190301/secretbundles/actions/getByName?secretName=DB_PASSWORD&vaultId=${VAULT}`,
        `/20190301/secretbundles/actions/getByName?secretName=MISSING&vaultId=${VAULT}`,
        `/20190301/secretbundles/${SECRET}`,
      ])
      expect(requests.every(request => request.authorization?.startsWith('Signature version="1"'))).toBe(true)
    } finally {
      config.cleanup()
    }
  })

  it('fails with a hint when the config file cannot be read', async () => {
    const error = await caught(() =>
      loadConfigSource([ociVault({ secretId: SECRET, configFile: '/nonexistent/oci/config', endpoint })], { env: {} }),
    )
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('cannot set up the config-file authentication')
    expect((error as ZnightError).hints.join('\n')).toContain('oci setup config')
  })
})
