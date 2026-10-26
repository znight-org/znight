import type { MarkdownRenderer } from 'vitepress'

import { resolve } from 'node:path'
import { createMarkdownRenderer } from 'vitepress'

import { repositoryLinks } from '../.vitepress/repository-links.ts'
import { beforeAll, describe, expect, test as it } from 'bun:test'

const docsDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(docsDir, '..')
const GITHUB = 'https://github.com/ugho49/Znight'

let md: MarkdownRenderer

beforeAll(async () => {
  md = await createMarkdownRenderer(docsDir, {}, '/')
  md.use(repositoryLinks, { docsDir, repoRoot, githubUrl: GITHUB })
})

/** Renders `source` as if it were the page `page` (relative to docs/) and returns its hrefs. */
function hrefs(source: string, page: string, realPage: string = page): string[] {
  const html = md.render(source, {
    path: resolve(docsDir, page),
    realPath: resolve(docsDir, realPage),
    relativePath: page,
    cleanUrls: true,
  })
  return [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1] ?? '')
}

describe('repositoryLinks', () => {
  it('rewrites relative links leaving the documentation to GitHub', () => {
    expect(hrefs('[errors](../../packages/core/src/errors.ts)', 'packages/core.md')).toEqual([
      `${GITHUB}/blob/main/packages/core/src/errors.ts`,
    ])
  })

  it('keeps the fragment and the query string', () => {
    expect(hrefs('[readme](../../packages/core/README.md#scopes)', 'packages/core.md')).toEqual([
      `${GITHUB}/blob/main/packages/core/README.md#scopes`,
    ])
  })

  it('resolves links relative to the file on disk for rewritten pages', () => {
    // docs/internals/architecture.md is served as /contributing/architecture
    expect(
      hrefs(
        '[metadata](../../packages/core/src/metadata.ts)',
        'contributing/architecture.md',
        'internals/architecture.md',
      ),
    ).toEqual([`${GITHUB}/blob/main/packages/core/src/metadata.ts`])
    expect(hrefs('[license](../../LICENSE)', 'contributing/architecture.md', 'internals/architecture.md')).toEqual([
      `${GITHUB}/blob/main/LICENSE`,
    ])
    // served one level deeper than the source: resolving from the served path would land in docs/
    expect(
      hrefs(
        '[metadata](../../packages/core/src/metadata.ts)',
        'contributing/specs/architecture.md',
        'internals/architecture.md',
      ),
    ).toEqual([`${GITHUB}/blob/main/packages/core/src/metadata.ts`])
  })

  it('leaves links to documentation pages to VitePress', () => {
    expect(hrefs('[scopes](./scopes.md)', 'guide/lifecycle.md')).toEqual(['./scopes'])
    expect(hrefs('[errors](/reference/error-codes#znight001)', 'guide/lifecycle.md')).toEqual([
      '/reference/error-codes#znight001',
    ])
    expect(hrefs('[top](#lifecycle)', 'guide/lifecycle.md')).toEqual(['#lifecycle'])
  })

  it('leaves external and outside-of-repository links untouched', () => {
    expect(hrefs('[vite](https://vite.dev)', 'guide/lifecycle.md')).toEqual(['https://vite.dev'])
    expect(hrefs('[mail](mailto:hi@example.com)', 'guide/lifecycle.md')).toEqual(['mailto:hi@example.com'])
    expect(hrefs('[outside](../../../../outside.ts)', 'guide/lifecycle.md')).toEqual(['../../../../outside.ts'])
  })
})
