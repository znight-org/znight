/**
 * The `@znight/config/compiler` entry: extension shape, package wiring (exports, manifest, tsdown)
 * and the boundary rules of compiler extensions (spec §2).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXTENSION_API_VERSION } from '@znight/compiler'

import * as entry from '../../src/compiler/index.ts'
import { CONFIG_EXTENSION_NAME, CONFIG_SOURCE_TOKEN } from '../../src/index.ts'
import { describe, expect, it } from 'bun:test'

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url))

describe('@znight/config/compiler', () => {
  it('default-exports the config extension', () => {
    expect(entry.default).toBe(entry.configExtension)
    expect(Object.keys(entry).sort()).toEqual(['ConfigDecorator', 'configExtension', 'default'])
    const extension = entry.configExtension
    expect(extension.apiVersion).toBe(EXTENSION_API_VERSION)
    expect(extension.name).toBe(CONFIG_EXTENSION_NAME)
    expect(typeof extension.analyzeClass).toBe('function')
    expect(typeof extension.validate).toBe('function')
    expect(typeof extension.generate).toBe('function')
    expect(Object.isFrozen(extension)).toBe(true)
  })

  it('owns the config decorators with static arguments', () => {
    expect(entry.configExtension.decorators).toEqual({
      '@znight/config#Config': { targets: ['class'], params: ['static'] },
      '@znight/config#Env': { targets: ['property'], params: ['static'] },
      '@znight/config#Secret': { targets: ['property'], params: ['static'] },
      '@znight/config#Default': { targets: ['property'], params: ['static'] },
      '@znight/config#Key': { targets: ['property'], params: ['static'] },
    })
    expect(Object.values<string>(entry.ConfigDecorator).sort()).toEqual(
      Object.keys(entry.configExtension.decorators).sort(),
    )
  })

  it('resolves through the package exports (self-reference)', async () => {
    const resolved = await import('@znight/config/compiler')
    expect(resolved.default).toBe(entry.default)
  })

  it('is declared in the package manifest, exports and tsdown entries', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'))
    expect(manifest.znight).toEqual({
      apiVersion: 1,
      compiler: '@znight/config/compiler',
      provides: [{ export: 'ConfigSource', plugin: 'ConfigPlugin', scope: 'singleton' }],
    })
    expect(`${manifest.name}#${manifest.znight.provides[0].export}`).toBe(CONFIG_SOURCE_TOKEN)
    expect(manifest.exports['./compiler']).toEqual({
      '@znight/source': './src/compiler/index.ts',
      types: './dist/compiler.d.mts',
      default: './dist/compiler.mjs',
    })
    expect(manifest.peerDependenciesMeta['@znight/compiler']).toEqual({ optional: true })
    const tsdown = fs.readFileSync(path.join(PACKAGE, 'tsdown.config.ts'), 'utf8')
    expect(tsdown).toContain("index: 'src/index.ts'")
    expect(tsdown).toContain("compiler: 'src/compiler/index.ts'")
  })

  it('only imports types from @znight/compiler and never the runtime entry', () => {
    const directory = path.join(PACKAGE, 'src/compiler')
    const allowed = new Set(['../coerce.ts', '../conventions.ts'])
    for (const file of fs.readdirSync(directory)) {
      const source = fs.readFileSync(path.join(directory, file), 'utf8')
      for (const match of source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm)) {
        const [, typeOnly, specifier] = match as unknown as [string, string | undefined, string]
        if (typeOnly !== undefined) continue
        expect({ file, specifier, ok: specifier.startsWith('./') || allowed.has(specifier) }).toEqual({
          file,
          specifier,
          ok: true,
        })
      }
    }
  })

  it('keeps the runtime modules it imports import-free', () => {
    for (const file of ['coerce.ts', 'conventions.ts']) {
      const source = fs.readFileSync(path.join(PACKAGE, 'src', file), 'utf8')
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm)]
        .filter(match => match[1] === undefined)
        .map(match => match[2])
      expect(imports.every(specifier => specifier === './conventions.ts')).toBe(true)
    }
  })

  it('is not imported by the runtime entry', () => {
    for (const file of fs.readdirSync(path.join(PACKAGE, 'src'))) {
      if (!file.endsWith('.ts')) continue
      expect(fs.readFileSync(path.join(PACKAGE, 'src', file), 'utf8')).not.toContain('./compiler')
    }
  })
})
