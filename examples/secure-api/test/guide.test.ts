import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test as it } from 'bun:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const GUIDE = join(ROOT, '../../docs/guide/security.md')

interface Block {
  readonly file: string
  readonly excerpt: boolean
  readonly code: string
}

/** The code blocks of the guide that name a file of this example: ```ts [src/http.ts] */
function namedBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  for (const match of markdown.matchAll(/^```\w+ \[([^\]\s]+)( \(excerpt\))?\]\n([\s\S]*?)\n```$/gm)) {
    blocks.push({ file: match[1] ?? '', excerpt: match[2] !== undefined, code: match[3] ?? '' })
  }
  return blocks
}

/**
 * The Security guide states that its recipes ARE the files of this example: a block naming a file
 * holds that file, byte for byte, or contiguous parts of it (`(excerpt)`, parts separated by
 * `// ...`). Change the file, then copy it into the guide.
 */
describe('docs/guide/security.md', () => {
  const blocks = namedBlocks(readFileSync(GUIDE, 'utf8'))

  it('embeds the recipes of this example', () => {
    expect(blocks.map(block => block.file)).toContain('src/auth/auth.guard.ts')
    expect(blocks.length).toBeGreaterThan(20)
  })

  const source = (block: Block): string => readFileSync(join(ROOT, block.file), 'utf8').trimEnd()
  const whole = blocks.filter(block => !block.excerpt)
  const excerpts = blocks.filter(block => block.excerpt)

  it.each(whole.map(block => [block.file, block] as const))('%s is the source file', (_, block) => {
    expect(block.code).toBe(source(block))
  })

  it.each(excerpts.map(block => [block.file, block] as const))(
    '%s (excerpt) is made of parts of the source',
    (_, block) => {
      for (const part of block.code.split(/\n[ \t]*\/\/ \.\.\.\n/)) expect(source(block)).toContain(part)
    },
  )
})
