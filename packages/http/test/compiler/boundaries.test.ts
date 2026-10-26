/**
 * Boundary rules of the compiler extension (architecture §2): `@znight/http/compiler` only imports
 * types from `@znight/compiler` and pure, import-free runtime modules (never the runtime entry, so
 * building never loads fastify, express or hono), and runtime modules never import `./compiler`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
/** Runtime modules the compiler entry may import: they import nothing. */
const PURE = ['path.ts', 'mime.ts', 'size.ts']

function valueImports(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8')
  return [...source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm)]
    .filter(match => match[1] === undefined)
    .map(match => match[2] as string)
}

function sources(directory: string): string[] {
  return fs
    .readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => path.join(directory, file))
}

describe('@znight/http/compiler boundaries', () => {
  it('only value-imports its own modules and pure runtime modules', () => {
    for (const file of sources(path.join(SRC, 'compiler'))) {
      for (const specifier of valueImports(file)) {
        const ok = specifier.startsWith('./') || PURE.some(pure => specifier === `../${pure}`)
        expect({ file: path.basename(file), specifier, ok }).toEqual({ file: path.basename(file), specifier, ok: true })
      }
    }
  })

  it('keeps the pure runtime modules import-free', () => {
    for (const pure of PURE) {
      expect({ pure, imports: valueImports(path.join(SRC, pure)) }).toEqual({ pure, imports: [] })
    }
  })

  it('never imports the compiler entry from runtime modules', () => {
    for (const file of sources(SRC).filter(file => !file.includes(`${path.sep}compiler${path.sep}`))) {
      const imports = valueImports(file).filter(specifier => specifier.includes('compiler'))
      expect({ file: path.relative(SRC, file), imports }).toEqual({ file: path.relative(SRC, file), imports: [] })
    }
  })
})
