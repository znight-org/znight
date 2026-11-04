/**
 * The recipes of the GraphQL guide (`docs/guide/graphql.md`) are the files of this folder, tested
 * next to them: the guide shows each file from its first import, as is.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, test as it } from 'bun:test'

const GUIDE = resolve(import.meta.dir, '../../../../docs/guide/graphql.md')

/** The code of the fenced block titled `[title]` in the guide. */
function codeBlock(markdown: string, title: string): string | undefined {
  const start = markdown.indexOf(`\`\`\`ts [${title}]\n`)
  if (start === -1) return undefined
  const from = markdown.indexOf('\n', start) + 1
  return markdown.slice(from, markdown.indexOf('\n```', from))
}

describe.skipIf(!existsSync(GUIDE))('the GraphQL guide', () => {
  const guide = existsSync(GUIDE) ? readFileSync(GUIDE, 'utf8') : ''

  it.each([
    ['src/graphql/redis-pubsub.ts', 'redis-pubsub.ts'],
    ['src/graphql/yoga.controller.ts', 'yoga.controller.ts'],
  ])('shows %s as is', (title, file) => {
    const source = readFileSync(join(import.meta.dir, file), 'utf8')
    const code = source.slice(source.indexOf('\nimport ') + 1).trimEnd()

    expect(codeBlock(guide, title)).toBe(code)
  })

  it('links to the files of the recipes', () => {
    expect(guide).toContain('](../../packages/graphql/test/recipes/redis-pubsub.ts)')
    expect(guide).toContain('](../../packages/graphql/test/recipes/yoga.controller.ts)')
  })
})
