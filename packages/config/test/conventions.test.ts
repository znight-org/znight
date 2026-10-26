import { CONFIG_SOURCE_TOKEN, ConfigTokens, constantCase, defaultEnvName, defaultKeyPath } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

describe('constantCase', () => {
  it.each([
    ['port', 'PORT'],
    ['databaseUrl', 'DATABASE_URL'],
    ['maxConnections', 'MAX_CONNECTIONS'],
    ['HTTPPort', 'HTTP_PORT'],
    ['apiKeyV2', 'API_KEY_V2'],
    ['v2Endpoint', 'V2_ENDPOINT'],
    ['oauth2ClientId', 'OAUTH2_CLIENT_ID'],
    ['my-app.db', 'MY_APP_DB'],
    ['ALREADY_CONSTANT', 'ALREADY_CONSTANT'],
    ['_private', 'PRIVATE'],
    ['a', 'A'],
  ])('%p → %p', (input, expected) => {
    expect(constantCase(input)).toBe(expected)
  })
})

describe('defaults', () => {
  it('derives environment names from the prefix and the property', () => {
    expect(defaultEnvName('database', 'maxConnections')).toBe('DATABASE_MAX_CONNECTIONS')
    expect(defaultEnvName('httpServer', 'port')).toBe('HTTP_SERVER_PORT')
    expect(defaultEnvName(undefined, 'port')).toBe('PORT')
    expect(defaultEnvName('', 'logLevel')).toBe('LOG_LEVEL')
  })

  it('derives key paths from the prefix and the property', () => {
    expect(defaultKeyPath('database', 'maxConnections')).toBe('database.maxConnections')
    expect(defaultKeyPath('app.http', 'port')).toBe('app.http.port')
    expect(defaultKeyPath(undefined, 'port')).toBe('port')
    expect(defaultKeyPath('', 'port')).toBe('port')
  })
})

it('exposes the ConfigSource token', () => {
  expect(CONFIG_SOURCE_TOKEN).toBe('@znight/config#ConfigSource')
  expect(ConfigTokens.Source).toBe(CONFIG_SOURCE_TOKEN)
  expect(Object.isFrozen(ConfigTokens)).toBe(true)
})
