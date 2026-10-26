import type { DefaultTheme } from 'vitepress'

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { ERROR_DESCRIPTIONS, ErrorCode } from '../../packages/core/src/errors.ts'
import config from '../.vitepress/config.ts'
import { describe, expect, test as it } from 'bun:test'

const docsDir = resolve(import.meta.dir, '..')

/** Markdown pages of the site, relative to `docs/` (POSIX separators). */
function pages(dir = docsDir): string[] {
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'public') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...pages(path))
    else if (entry.name.endsWith('.md')) result.push(relative(docsDir, path).split('\\').join('/'))
  }
  return result.sort()
}

/** Source file of a site path (`/guide/scopes`, `/packages/`), following `rewrites`. */
function sourceOf(link: string): string | undefined {
  const path = link.replace(/[?#].*$/, '').replace(/^\//, '')
  const page = path === '' || path.endsWith('/') ? `${path}index.md` : `${path}.md`
  if (existsSync(join(docsDir, page))) return page
  const rewrites = (config.rewrites ?? {}) as Record<string, string>
  for (const [from, to] of Object.entries(rewrites)) {
    const pattern = new RegExp(`^${to.replace(/:[a-z]+/g, '([^/]+)')}$`)
    const match = pattern.exec(page)
    if (match === null) continue
    let index = 1
    const source = from.replace(/:[a-z]+/g, () => match[index++] ?? '')
    if (existsSync(join(docsDir, source))) return source
  }
  return undefined
}

function navLinks(items: readonly (DefaultTheme.NavItem | DefaultTheme.NavItemChildren)[]): string[] {
  return items.flatMap(item => {
    const links: string[] = []
    if ('link' in item && typeof item.link === 'string') links.push(item.link)
    if ('items' in item && Array.isArray(item.items)) links.push(...navLinks(item.items))
    return links
  })
}

function sidebarLinks(items: readonly DefaultTheme.SidebarItem[]): string[] {
  return items.flatMap(item => [...(item.link === undefined ? [] : [item.link]), ...sidebarLinks(item.items ?? [])])
}

const isInternal = (link: string): boolean => link.startsWith('/')

describe('navigation', () => {
  const theme = config.themeConfig as DefaultTheme.Config
  const sidebars = Object.values(theme.sidebar ?? {}) as DefaultTheme.SidebarItem[][]
  const links = [...navLinks(theme.nav ?? []), ...sidebars.flatMap(sidebarLinks)].filter(isInternal)

  it('has links', () => {
    expect(links.length).toBeGreaterThan(20)
  })

  it.each([...new Set(links)])('%s points to an existing page', link => {
    expect(sourceOf(link)).toBeDefined()
  })

  it('every guide, package and reference page is in a sidebar', () => {
    const linked = new Set(links.map(sourceOf))
    const orphans = pages().filter(page => /^(guide|packages|reference|contributing)\//.test(page) && !linked.has(page))
    expect(orphans).toEqual([])
  })

  it('the architecture specification is rendered under /contributing/', () => {
    expect(sourceOf('/contributing/architecture')).toBe('internals/architecture.md')
  })
})

describe('pages', () => {
  const owned = pages().filter(page => !page.startsWith('internals/'))

  it.each(owned)('%s has a frontmatter description', page => {
    const text = readFileSync(join(docsDir, page), 'utf8')
    expect(text).toMatch(/^---\n(?:.*\n)*?description: .+\n(?:.*\n)*?---\n/)
  })

  it.each(owned)('%s marks pending APIs with the agreed marker only', page => {
    const text = readFileSync(join(docsDir, page), 'utf8')
    for (const todo of text.match(/<!--\s*TODO[^>]*-->/g) ?? []) {
      expect(todo).toStartWith('<!-- TODO(api): verify against implementation')
    }
  })
})

describe('error reference', () => {
  const text = readFileSync(join(docsDir, 'reference/error-codes.md'), 'utf8')
  const codes = Object.values(ErrorCode)

  it('covers ZNIGHT001 to ZNIGHT021', () => {
    expect(codes).toHaveLength(21)
  })

  it.each(codes)('%s has a section with a stable anchor', code => {
    const heading = new RegExp(`^## ${code}: .+ \\{#${code.toLowerCase()}\\}$`, 'm')
    expect(text).toMatch(heading)
    expect(ERROR_DESCRIPTIONS[code]).toBeString()
  })

  it.each(codes)('%s is listed in the summary table', code => {
    expect(text).toContain(`| [${code}](#${code.toLowerCase()}) |`)
  })

  it('documents no unknown code', () => {
    const documented = [...text.matchAll(/^## (ZNIGHT\d{3}):/gm)].map(match => match[1])
    expect(documented).toEqual(codes)
  })
})
