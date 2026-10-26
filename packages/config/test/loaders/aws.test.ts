import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GetSecretValueInputLike, GetSecretValueOutputLike, SecretsManagerClientLike } from '../../src/index.ts'

import { createServer } from 'node:http'
import { ErrorCode, type ZnightError } from '@znight/core'

import { awsSecretsManager, ConfigLoaderError, inline, loadConfigSource } from '../../src/index.ts'
import { caught } from '../helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const SECRETS: Record<string, GetSecretValueOutputLike> = {
  'prod/app': { SecretString: JSON.stringify({ DB_PASSWORD: 'json-password', database: { user: 'app' } }) },
  'prod/db-password': { SecretString: 'plain-password' },
  'prod/braces': { SecretString: '{not json' },
  'prod/array': { SecretString: '["a"]' },
  'prod/binary': { SecretBinary: new TextEncoder().encode('{"BINARY":"yes"}') },
  'prod/empty': {},
}

class NamedError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

function fakeClient(
  calls: { input: GetSecretValueInputLike; signal: AbortSignal | undefined }[] = [],
): SecretsManagerClientLike {
  return {
    getSecretValue: input => {
      return Promise.resolve().then(() => {
        calls.push({ input, signal: undefined })
        if (input.SecretId === 'prod/denied') throw new NamedError('AccessDeniedException', 'not authorized')
        const secret = SECRETS[input.SecretId]
        if (secret === undefined)
          throw new NamedError('ResourceNotFoundException', "Secrets Manager can't find the specified secret.")
        return secret
      })
    },
  }
}

describe('awsSecretsManager() with a client', () => {
  it('reads JSON object secrets as key/value maps', async () => {
    const source = await loadConfigSource([awsSecretsManager({ secretId: 'prod/app', client: fakeClient() })], {
      env: {},
    })
    expect(source.get('DB_PASSWORD')).toBe('json-password')
    expect(source.get('database.user')).toBe('app')
    expect(source.origin('DB_PASSWORD')).toBe('aws-secrets-manager:prod/app')
  })

  it('stores plain secrets under their key (default: the secret id)', async () => {
    const source = await loadConfigSource(
      [
        awsSecretsManager({
          secretId: [
            'prod/db-password',
            { secretId: 'prod/db-password', key: 'DB_PASSWORD' },
            'prod/braces',
            'prod/array',
          ],
          client: fakeClient(),
        }),
      ],
      { env: {} },
    )
    expect(source.get('prod/db-password')).toBe('plain-password')
    expect(source.get('DB_PASSWORD')).toBe('plain-password')
    expect(source.get('prod/braces')).toBe('{not json')
    expect(source.get('prod/array')).toBe('["a"]')
  })

  it('mounts JSON secrets under a key and decodes binary secrets', async () => {
    const source = await loadConfigSource(
      [
        awsSecretsManager({
          secretId: [{ secretId: 'prod/app', key: 'secrets' }, 'prod/binary'],
          client: fakeClient(),
        }),
      ],
      { env: {} },
    )
    expect(source.get('secrets.DB_PASSWORD')).toBe('json-password')
    expect(source.get('BINARY')).toBe('yes')
  })

  it('passes version selectors and a timeout signal', async () => {
    const received: { input: GetSecretValueInputLike; options: unknown }[] = []
    const client: SecretsManagerClientLike = {
      getSecretValue: async (input, options) => {
        received.push({ input, options })
        return await Promise.resolve({ SecretString: 'x' })
      },
    }
    await loadConfigSource(
      [awsSecretsManager({ secretId: { secretId: 's', versionStage: 'AWSPREVIOUS', versionId: 'v1' }, client })],
      { env: {} },
    )
    expect(received[0]?.input).toEqual({ SecretId: 's', VersionStage: 'AWSPREVIOUS', VersionId: 'v1' })
    const options = received[0]?.options as { abortSignal?: unknown } | undefined
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('later secrets override earlier ones', async () => {
    const source = await loadConfigSource(
      [
        awsSecretsManager({
          secretId: ['prod/app', { secretId: 'prod/db-password', key: 'DB_PASSWORD' }],
          client: fakeClient(),
        }),
      ],
      { env: {} },
    )
    expect(source.get('DB_PASSWORD')).toBe('plain-password')
  })

  it('fails on missing secrets unless optional (per secret or globally)', async () => {
    const error = await caught(() =>
      loadConfigSource([awsSecretsManager({ secretId: 'prod/unknown', client: fakeClient() })], { env: {} }),
    )
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toBe(
      'ZNIGHT006: Config loader "aws-secrets-manager" failed: cannot read secret "prod/unknown": ResourceNotFoundException: Secrets Manager can\'t find the specified secret.',
    )
    const perSecret = await loadConfigSource(
      [
        awsSecretsManager({
          secretId: [{ secretId: 'prod/unknown', optional: true }, 'prod/app'],
          client: fakeClient(),
        }),
      ],
      { env: {} },
    )
    expect(perSecret.get('DB_PASSWORD')).toBe('json-password')
    const global = await loadConfigSource(
      [awsSecretsManager({ secretId: ['prod/unknown'], optional: true, client: fakeClient() })],
      { env: {} },
    )
    expect(global.keys()).toEqual([])
  })

  it('never skips other errors, even when optional', async () => {
    const error = await caught(() =>
      loadConfigSource([awsSecretsManager({ secretId: 'prod/denied', optional: true, client: fakeClient() })], {
        env: {},
      }),
    )
    expect(error.message).toContain('cannot read secret "prod/denied": AccessDeniedException: not authorized')
    expect((error.cause as Error).name).toBe('AccessDeniedException')
  })

  it('reports secrets without value', async () => {
    const error = await caught(() =>
      loadConfigSource([awsSecretsManager({ secretId: 'prod/empty', client: fakeClient() })], { env: {} }),
    )
    expect(error.message).toContain('secret "prod/empty" has no value')
  })

  it('supports modular clients (send) with GetSecretValueCommand from the SDK', async () => {
    const commands: unknown[] = []
    const client: SecretsManagerClientLike = {
      send: async command => {
        commands.push(command)
        return await Promise.resolve({ SecretString: '{"SENT":"yes"}' })
      },
    }
    const source = await loadConfigSource([awsSecretsManager({ secretId: 'prod/sent', client })], { env: {} })
    expect(source.get('SENT')).toBe('yes')
    const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager')
    expect(commands[0]).toBeInstanceOf(GetSecretValueCommand)
    expect((commands[0] as { input: unknown }).input).toEqual({ SecretId: 'prod/sent' })
  })

  it('does not destroy injected clients', async () => {
    let destroyed = false
    const client = {
      ...fakeClient(),
      destroy: () => {
        destroyed = true
      },
    }
    await loadConfigSource([awsSecretsManager({ secretId: 'prod/app', client })], { env: {} })
    expect(destroyed).toBe(false)
  })

  it('validates its options when configured', async () => {
    const cases: unknown[] = [
      {},
      { secretId: '' },
      { secretId: [] },
      { secretId: [{ key: 'x' }] },
      { secretId: 'x', client: {} },
    ]
    for (const options of cases) {
      const error = await caught(() => awsSecretsManager(options as never))
      expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
    }
  })
})

describe('awsSecretsManager() with the AWS SDK', () => {
  let server: Server
  let endpoint: string
  const requests: { target: string | undefined; body: Record<string, unknown>; authorization: string | undefined }[] =
    []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => {
        raw += chunk
      })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>
        requests.push({
          target: req.headers['x-amz-target'] as string | undefined,
          body,
          authorization: req.headers.authorization,
        })
        if (body['SecretId'] === 'prod/missing') {
          res.writeHead(400, {
            'content-type': 'application/x-amz-json-1.1',
            'x-amzn-errortype': 'ResourceNotFoundException',
          })
          res.end(JSON.stringify({ __type: 'ResourceNotFoundException', message: 'not found' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
        res.end(
          JSON.stringify({
            ARN: `arn:aws:secretsmanager:eu-west-3:123456789012:secret:${String(body['SecretId'])}`,
            Name: body['SecretId'],
            SecretString: JSON.stringify({ SDK_SECRET: `value-of-${String(body['SecretId'])}` }),
            VersionId: 'v1',
          }),
        )
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  // dummy credentials for the local fake endpoint
  const clientConfig = () => ({
    endpoint,
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'fake-secret-for-tests' },
    maxAttempts: 1,
  })

  it('creates a SecretsManagerClient (region from previous loaders) and calls GetSecretValue', async () => {
    const source = await loadConfigSource(
      [inline({ AWS_REGION: 'eu-west-3' }), awsSecretsManager({ secretId: 'prod/sdk', clientConfig: clientConfig() })],
      { env: {} },
    )
    expect(source.get('SDK_SECRET')).toBe('value-of-prod/sdk')
    const request = requests.at(-1)
    expect(request?.target).toBe('secretsmanager.GetSecretValue')
    expect(request?.body).toEqual({ SecretId: 'prod/sdk' })
    expect(request?.authorization).toContain('eu-west-3/secretsmanager')
  })

  it('maps SDK errors', async () => {
    const error = await caught(() =>
      loadConfigSource(
        [awsSecretsManager({ secretId: 'prod/missing', region: 'us-east-1', clientConfig: clientConfig() })],
        { env: {} },
      ),
    )
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('cannot read secret "prod/missing": ResourceNotFoundException')
    const optional = await loadConfigSource(
      [
        awsSecretsManager({
          secretId: 'prod/missing',
          optional: true,
          region: 'us-east-1',
          clientConfig: clientConfig(),
        }),
      ],
      { env: {} },
    )
    expect(optional.keys()).toEqual([])
  })
})
