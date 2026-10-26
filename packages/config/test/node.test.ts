import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { tempDir } from './helpers.ts'
import { expect, it } from 'bun:test'

const node = Bun.which('node')
const packageDir = fileURLToPath(new URL('..', import.meta.url))

it.skipIf(node === null)(
  'runs on Node.js from sources (loaders, coercion, masking, ConfigPlugin)',
  async () => {
    const { dir, cleanup } = await tempDir({
      'config.json': JSON.stringify({ database: { host: 'json-host' } }),
      'config.yaml': 'database:\n  host: yaml-host\n',
      '.env': 'DB_PASSWORD=from-dotenv\n',
    })
    try {
      const result = spawnSync(node as string, ['--conditions=@znight/source', 'test/fixtures/node-smoke.mjs', dir], {
        cwd: packageDir,
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        origins: 'config.json < config.yaml < .env < process.env < vault:secret/app < aws-secrets-manager:prod/app',
        vault: '/v1/secret/data/app',
        aws: 'prod/app',
        config: { host: 'yaml-host', port: 6000, password: 'from-dotenv' },
        inspect: "DbConfig { host: 'yaml-host', port: 6000, password: '[REDACTED]' }",
        json: '{"host":"yaml-host","port":6000,"password":"[REDACTED]"}',
        validation: 'ZNIGHT006',
        invalidVaultResponse: {
          message:
            'ZNIGHT006: Config loader "vault" failed: cannot read secret secret/invalid after 1 attempt(s): the response body is not valid JSON (50 characters, application/json)',
          leaked: false,
        },
      })
    } finally {
      cleanup()
    }
  },
  30_000,
)
