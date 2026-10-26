import { readFileSync } from 'node:fs'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { describe, expect, test as it } from 'bun:test'

// What the compiler generated from this service and the shared source library (the bunfig.toml
// preload regenerates it before the tests). Not something to test in an application: it documents
// the provider library mechanics.
describe('generated container', () => {
  const generated = readFileSync(new URL('../src/.znight/container.generated.ts', import.meta.url), 'utf8')

  it('registers the providers of the shared source library, with package tokens', () => {
    const library = Object.keys(metadata.providers).filter(token => token.startsWith('@znight-examples/shared#'))
    // RandomIdGenerator, superseded by the @Primary SortableIdGenerator, is pruned (znight.config.ts)
    expect(library).toEqual(['@znight-examples/shared#SystemClock', '@znight-examples/shared#UserDirectory'])
  })

  it('imports them through the public entry of the package, never through a path', () => {
    expect(generated).toContain(
      "import { CreateUserInput, SystemClock, UpdateUserInput, UserDirectory } from '@znight-examples/shared'",
    )
    expect(generated).not.toContain('packages/shared')
  })

  it('binds the IdGenerator of the library provider to the local @Primary implementation', () => {
    const sortable = 'src/ids/sortable-id.generator.ts#SortableIdGenerator'
    expect(metadata.providers['@znight-examples/shared#UserDirectory']?.deps).toEqual([
      '@znight-examples/shared#SystemClock', // Clock: an interface, a single implementation
      sortable, // IdGenerator: RandomIdGenerator (library) and SortableIdGenerator (@Primary, here)
    ])
    expect(metadata.aliases?.['@znight-examples/shared#IdGenerator']).toBe(sortable)
    expect(metadata.aliases?.['@znight-examples/shared#Clock']).toBe('@znight-examples/shared#SystemClock')
  })
})
