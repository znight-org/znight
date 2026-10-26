// Runs on Node.js (type stripping) to check that the sources work outside of Bun.
// Usage: node --conditions=@znight/source test/fixtures/node-smoke.mjs <fixture dir>

import { createServer } from 'node:http'
import { inspect } from 'node:util'
import { Application, silentLogger } from '@znight/core'

import {
  awsSecretsManager,
  ConfigPlugin,
  dotenv,
  env,
  inline,
  json,
  loadConfig,
  loadConfigSource,
  vault,
  yaml,
} from '../../src/index.ts'

const cwd = process.argv[2]
const results = {}

class DbConfig {
  host = 'localhost'
  port = 5432
  password
}

const fields = [
  { property: 'host', env: 'DB_HOST', key: 'database.host', type: 'string', required: false, secret: false },
  { property: 'port', env: 'DB_PORT', key: 'database.port', type: 'number', required: false, secret: false },
  { property: 'password', env: 'DB_PASSWORD', key: 'database.password', type: 'string', required: true, secret: true },
]

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => {
    raw += chunk
  })
  req.on('end', () => {
    if (req.url?.startsWith('/v1/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { data: { VAULT_VALUE: req.url } } }))
      return
    }
    const body = JSON.parse(raw || '{}')
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
    res.end(JSON.stringify({ Name: body.SecretId, SecretString: JSON.stringify({ AWS_VALUE: body.SecretId }) }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}`

try {
  const source = await loadConfigSource(
    [
      json('config.json'),
      yaml('config.yaml'),
      dotenv(),
      env(),
      vault({ address: endpoint, token: 'node-token', path: 'secret/app' }),
      awsSecretsManager({
        secretId: 'prod/app',
        region: 'eu-west-1',
        clientConfig: {
          endpoint,
          credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'fake' },
          maxAttempts: 1,
        },
      }),
    ],
    { cwd, env: { DB_PORT: '6000' } },
  )
  results.origins = source.describe()
  results.vault = source.get('VAULT_VALUE')
  results.aws = source.get('AWS_VALUE')

  const config = loadConfig(DbConfig, source, fields)
  results.config = { host: config.host, port: config.port, password: config.password }
  results.inspect = inspect(config)
  results.json = JSON.stringify(config)

  const app = await Application.create({
    metadata: {
      version: 1,
      providers: {
        'src/db.ts#DbConfig': {
          scope: 'singleton',
          class: DbConfig,
          deps: [{ token: '@znight/config#ConfigSource', optional: true }],
          factory: d => loadConfig(DbConfig, d[0], fields),
        },
      },
      resolutionOrder: ['src/db.ts#DbConfig'],
      extensions: { config: { configs: [{ token: 'src/db.ts#DbConfig', fields }] } },
    },
    plugins: [ConfigPlugin.configure({ loaders: [inline({})] })],
    logger: silentLogger,
    shutdown: { signals: false },
  }).catch(error => error)
  results.validation = app.code
} finally {
  server.close()
}

process.stdout.write(JSON.stringify(results))
