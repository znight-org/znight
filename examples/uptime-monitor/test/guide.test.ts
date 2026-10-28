import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test as it } from 'bun:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const GUIDE = resolve(ROOT, '../../docs/guide/scheduling.md')

/** The code of the fenced block titled `[title]` in the guide. */
function codeBlock(markdown: string, title: string): string | undefined {
  const start = markdown.indexOf(`\`\`\`ts [${title}]\n`)
  if (start === -1) return undefined
  const from = markdown.indexOf('\n', start) + 1
  return markdown.slice(from, markdown.indexOf('\n```', from))
}

/**
 * The lock stores of the scheduling guide (`docs/guide/scheduling.md`) are the files of this
 * application, tested here: the guide shows each file from its first import, as is.
 */
describe.skipIf(!existsSync(GUIDE))('the scheduling guide', () => {
  const guide = existsSync(GUIDE) ? readFileSync(GUIDE, 'utf8') : ''

  it.each(['src/schedule/postgres-lock-store.ts', 'src/schedule/redis-lock-store.ts'])('shows %s as is', file => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const code = source.slice(source.indexOf('\nimport ') + 1).trimEnd()

    expect(codeBlock(guide, file)).toBe(code)
  })

  it('links to existing files of the example', () => {
    const links = [...guide.matchAll(/\]\((\.\.\/\.\.\/examples\/uptime-monitor\/[^)#\s]+)/g)].map(
      match => match[1] ?? '',
    )
    const missing = links.filter(link => !existsSync(resolve(dirname(GUIDE), link)))

    expect(links.length).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })
})
