import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { ApiKeys } from '../src/auth/api-keys.js'
import { describe, expect, test as it } from 'bun:test'

describe('ApiKeys', () => {
  it('identifies the client of each configured key', async () => {
    // `@Config` classes are real instances in TestBed, built from `config` values (by prefix)
    const { instance: keys } = await TestBed.create(ApiKeys, {
      metadata,
      config: { auth: { exportApiKeys: ['current-key', 'next-key'] } },
    })

    expect(keys.identify('current-key')).toEqual({ id: 'export-client', roles: ['exporter'], via: 'api-key' })
    expect(keys.identify('next-key')).toMatchObject({ id: 'export-client' })
    for (const wrong of ['', 'current', 'current-key ', 'CURRENT-KEY', 'x'.repeat(10_000)]) {
      expect(keys.identify(wrong)).toBeUndefined()
    }
  })

  it('accepts nothing without keys', async () => {
    const { instance: keys } = await TestBed.create(ApiKeys, { metadata, config: { auth: { exportApiKeys: [] } } })

    expect(keys.identify('')).toBeUndefined()
  })
})
