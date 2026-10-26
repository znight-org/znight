import manifest from '../package.json' with { type: 'json' }
import * as entry from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

describe('public entry and manifest', () => {
  it('exports every provided type and every interceptor decorator', () => {
    const exported = entry as Record<string, unknown>
    for (const provided of manifest.znight.provides) {
      expect(typeof exported[provided.export]).toBe('function')
      expect(provided.plugin).toBe('ObservabilityPlugin')
      expect(provided.scope).toBe('singleton')
      expect(Object.values(entry.ObservabilityTokens)).toContain(`${manifest.name}#${provided.export}`)
    }
    for (const binding of manifest.znight.interceptors) {
      expect(typeof exported[binding.decorator]).toBe('function')
      expect(typeof exported[binding.interceptor]).toBe('function')
      expect(manifest.znight.provides.map(provided => provided.export)).toContain(binding.interceptor)
    }
    expect(Object.keys(entry.ObservabilityTokens)).toHaveLength(manifest.znight.provides.length)
  })

  it('declares the integrations as optional peers and has no compiler extension', () => {
    expect(manifest.znight.apiVersion).toBe(1)
    expect(manifest.znight).not.toHaveProperty('compiler')
    expect(manifest.peerDependenciesMeta).toEqual({
      'pino-pretty': { optional: true },
      'prom-client': { optional: true },
    })
    expect(Object.keys(manifest.exports)).toEqual(['.', './package.json'])
  })

  it('does not load optional peers when imported', () => {
    expect(entry.ObservabilityPlugin.name).toBe('observability')
    expect(entry.REQUEST_ID_TOKEN).toBe('@znight/http#RequestId')
  })
})
