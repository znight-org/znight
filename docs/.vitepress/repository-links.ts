import type { MarkdownRenderer } from 'vitepress'

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

type Token = ReturnType<MarkdownRenderer['parse']>[number]

export interface RepositoryLinksOptions {
  /** Absolute path of the VitePress source directory. */
  readonly docsDir: string
  /** Absolute path of the repository root. */
  readonly repoRoot: string
  /** Repository URL, e.g. `https://github.com/znight-org/znight`. */
  readonly githubUrl: string
  /** Branch the links point to. Default: `main`. */
  readonly branch?: string
}

const SCHEME = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i

/**
 * markdown-it plugin turning relative links that leave the documentation (`../../packages/core/src/errors.ts`,
 * `../../README.md`) into links to the repository on GitHub. Pages can then link to source files the
 * same way on GitHub and on the website, and the architecture specification (rendered from
 * `docs/internals`) keeps working. Links to pages inside the documentation are left to VitePress
 * (and to its dead link check).
 */
export function repositoryLinks(md: MarkdownRenderer, options: RepositoryLinksOptions): void {
  const branch = options.branch ?? 'main'
  md.core.ruler.push('znight_repository_links', state => {
    const env = state.env as { readonly path?: string; readonly realPath?: string }
    // `realPath` is the file on disk (before `rewrites`): relative links are relative to it
    const file = env.realPath ?? env.path
    if (file === undefined) return
    const dir = dirname(file)
    for (const token of state.tokens) {
      for (const child of token.children ?? []) rewrite(child, dir)
    }
  })

  function rewrite(token: Token, dir: string): void {
    if (token.type !== 'link_open') return
    const href = token.attrGet('href')
    if (href === null || href === '' || href.startsWith('#') || href.startsWith('/') || SCHEME.test(href)) return
    const [, pathname = '', suffix = ''] = /^([^?#]*)(.*)$/.exec(href) ?? []
    const target = resolve(dir, decodeURI(pathname))
    if (isInside(options.docsDir, target) || !isInside(options.repoRoot, target)) return
    const path = relative(options.repoRoot, target).split(sep).join('/')
    token.attrSet('href', `${options.githubUrl}/blob/${branch}/${path}${suffix}`)
  }
}

function isInside(dir: string, target: string): boolean {
  const path = relative(dir, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}
