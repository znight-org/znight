import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test as it } from 'bun:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const GUIDE = resolve(ROOT, '../../docs/guide/graphql.md')

/** The GraphQL guide (`docs/guide/graphql.md`) points to files of this application: they must exist. */
describe.skipIf(!existsSync(GUIDE))('the GraphQL guide', () => {
  it('links to existing files of the example', () => {
    const guide = readFileSync(GUIDE, 'utf8')
    const links = [...guide.matchAll(/\]\((\.\.\/\.\.\/examples\/graphql-api\/[^)#\s]+)/g)].map(match => match[1] ?? '')
    const missing = links.filter(link => !existsSync(resolve(dirname(GUIDE), link)))

    expect(links.length).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })
})
