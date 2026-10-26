/**
 * The extension object, its entry point and the package boundaries (spec §2, §6.5, §7).
 */
import fs from 'node:fs'
import { EXTENSION_API_VERSION, validateExtension } from '@znight/compiler'

import * as constants from '../../src/compiler/constants.ts'
import extension, { messagingCompilerExtension } from '../../src/compiler/index.ts'
import { DEFAULT_BACKOFF, DEFAULT_RETRY_DELAY_MS, normalizeRetry } from '../../src/index.ts'
import { MESSAGING_DIR } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('compiler extension', () => {
  it('is a valid extension of the current API', () => {
    expect(validateExtension(extension)).toBeUndefined()
    expect(extension.apiVersion).toBe(EXTENSION_API_VERSION)
    expect(extension.name).toBe('messaging')
    expect(extension).toBe(messagingCompilerExtension)
    expect(Object.isFrozen(extension)).toBe(true)
  })

  it('owns the messaging decorators with their targets and argument kinds', () => {
    expect(extension.decorators).toEqual({
      '@znight/messaging#Consumer': { targets: ['class'], params: ['static'] },
      '@znight/messaging#OnMessage': { targets: ['method'], params: ['static'] },
      '@znight/messaging#Retry': { targets: ['method'], params: ['static'] },
      '@znight/messaging#OnError': { targets: ['method'], params: [] },
      '@znight/messaging#Message': { targets: ['parameter'], params: ['value'] },
      '@znight/messaging#Headers': { targets: ['parameter'], params: ['static'] },
      '@znight/messaging#Ctx': { targets: ['parameter'], params: [] },
    })
    expect(typeof extension.analyzeClass).toBe('function')
    expect(typeof extension.validate).toBe('function')
    expect(typeof extension.generate).toBe('function')
  })

  it('owns every decorator exported by the runtime entry', async () => {
    const runtime = await import('../../src/index.ts')
    for (const name of ['Consumer', 'OnMessage', 'Retry', 'OnError', 'Message', 'Headers', 'Ctx']) {
      expect(typeof (runtime as Record<string, unknown>)[name]).toBe('function')
      expect(Object.keys(extension.decorators)).toContain(`@znight/messaging#${name}`)
    }
  })

  it('uses the defaults of the runtime retry policy', () => {
    expect(constants.DEFAULT_BACKOFF).toBe(DEFAULT_BACKOFF)
    expect(constants.DEFAULT_RETRY_DELAY_MS).toBe(DEFAULT_RETRY_DELAY_MS)
    expect(() => normalizeRetry({ attempts: constants.MAX_RETRY_ATTEMPTS })).not.toThrow()
    expect(() => normalizeRetry({ attempts: constants.MAX_RETRY_ATTEMPTS + 1 })).toThrow(/attempts/)
  })
})

describe('entry point', () => {
  it('is exported as @znight/messaging/compiler (the manifest "compiler" module)', async () => {
    const pkg = JSON.parse(fs.readFileSync(`${MESSAGING_DIR}/package.json`, 'utf8')) as {
      exports: Record<string, unknown>
      znight: { compiler: string }
    }
    expect(pkg.znight.compiler).toBe('@znight/messaging/compiler')
    expect(pkg.exports['./compiler']).toEqual({
      '@znight/source': './src/compiler/index.ts',
      types: './dist/compiler.d.mts',
      default: './dist/compiler.mjs',
    })
    const entry = await import('@znight/messaging/compiler')
    expect(entry.default).toBe(extension)
    expect(entry.messagingCompilerExtension).toBe(extension)
  })

  it('is built by tsdown', () => {
    const config = fs.readFileSync(`${MESSAGING_DIR}/tsdown.config.ts`, 'utf8')
    expect(config).toContain("compiler: 'src/compiler/index.ts'")
  })

  it('only imports types from @znight/compiler and @znight/core, and never the runtime', () => {
    const dir = `${MESSAGING_DIR}/src/compiler`
    const files = fs.readdirSync(dir).filter(file => file.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = fs.readFileSync(`${dir}/${file}`, 'utf8')
      for (const match of source.matchAll(/^(import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm)) {
        const [statement, , typeOnly, specifier] = match as unknown as [string, string, string | undefined, string]
        if (typeOnly !== undefined) continue
        // value imports: sibling modules of the extension only
        expect({ file, statement, ok: /^\.\/[\w-]+\.ts$/.test(specifier) }).toEqual({ file, statement, ok: true })
      }
      expect(source).not.toMatch(/import\s*\(/)
    }
  })
})
