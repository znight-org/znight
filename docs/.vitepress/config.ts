import type { HeadConfig } from 'vitepress'

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DefaultTheme, defineConfig } from 'vitepress'

import { repositoryLinks } from './repository-links.ts'

const GITHUB_URL = 'https://github.com/znight-org/znight'
const TITLE = 'Znight'
const TAGLINE = 'Compile-time dependency injection for TypeScript'
const DESCRIPTION =
  'Znight is a TypeScript backend framework with compile-time dependency injection: a compiler resolves and validates your providers at build time, the runtime only runs generated factories.'

/** `docs/` (VitePress source directory) and the repository root. */
const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(docsDir, '..')

/**
 * Deployment settings, all optional:
 * - `ZNIGHT_DOCS_BASE`: public base path (e.g. `/znight/` for the GitHub Pages project site, set by docs.yml);
 * - `ZNIGHT_DOCS_URL`: origin of the site, without the base path (e.g. `https://znight-org.github.io`,
 *   set by docs.yml), used for absolute Open Graph URLs and the sitemap.
 */
const base = normalizeBase(process.env.ZNIGHT_DOCS_BASE)
const siteUrl = process.env.ZNIGHT_DOCS_URL?.replace(/\/+$/, '')

const version = readVersion()
const socialImage = absoluteUrl('social-preview.png')

export default defineConfig({
  lang: 'en-US',
  title: TITLE,
  description: DESCRIPTION,
  base,
  cleanUrls: true,
  lastUpdated: true,
  // The architecture specification lives in docs/internals (normative, edited with the code);
  // it is rendered as the "Contributing → Architecture" page.
  rewrites: {
    'internals/:page': 'contributing/:page',
  },
  sitemap: siteUrl === undefined ? undefined : { hostname: `${siteUrl}${base}` },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${base}favicon-32.png` }],
    ['link', { rel: 'apple-touch-icon', sizes: '512x512', href: `${base}mark-512.png` }],
    ['meta', { name: 'theme-color', content: '#3E7BFA' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: TITLE }],
    ['meta', { property: 'og:image', content: socialImage }],
    ['meta', { property: 'og:image:width', content: '1280' }],
    ['meta', { property: 'og:image:height', content: '640' }],
    ['meta', { property: 'og:image:alt', content: `${TITLE}: ${TAGLINE}` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: socialImage }],
  ],

  transformHead({ pageData }): HeadConfig[] {
    const title = pageData.frontmatter.layout === 'home' ? `${TITLE}: ${TAGLINE}` : `${pageData.title} | ${TITLE}`
    const description = pageData.description || DESCRIPTION
    const head: HeadConfig[] = [
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
    ]
    if (siteUrl !== undefined) {
      const page = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')
      head.push(['meta', { property: 'og:url', content: `${siteUrl}${base}${page}` }])
    }
    return head
  },

  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    config(md) {
      md.use(repositoryLinks, { docsDir, repoRoot, githubUrl: GITHUB_URL })
    },
  },

  themeConfig: {
    logo: { src: '/mark.svg', alt: TITLE },
    siteTitle: TITLE,
    nav: nav(),
    sidebar: {
      '/guide/': sidebarGuide(),
      '/examples': sidebarGuide(),
      '/roadmap': sidebarGuide(),
      '/contributing/': sidebarGuide(),
      '/packages/': sidebarPackages(),
      '/reference/': sidebarReference(),
    },
    editLink: {
      pattern: `${GITHUB_URL}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    lastUpdated: {
      text: 'Last updated',
      formatOptions: { dateStyle: 'medium' },
    },
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    externalLinkIcon: true,
    footer: {
      message: `Released under the <a href="${GITHUB_URL}/blob/main/LICENSE">MIT License</a>.`,
      copyright: 'Copyright © 2026-present Ugho STEPHAN and the Znight contributors',
    },
  },
})

function nav(): DefaultTheme.NavItem[] {
  return [
    { text: 'Guide', link: '/guide/introduction', activeMatch: '^/guide/' },
    { text: 'Examples', link: '/examples', activeMatch: '^/examples' },
    { text: 'Packages', link: '/packages/', activeMatch: '^/packages/' },
    {
      text: 'Reference',
      activeMatch: '^/reference/',
      items: [
        { text: 'Error codes', link: '/reference/error-codes' },
        { text: 'Decorators', link: '/reference/decorators' },
        { text: 'Architecture specification', link: '/contributing/architecture' },
      ],
    },
    {
      text: `v${version}`,
      items: [
        { text: 'Roadmap', link: '/roadmap' },
        { text: 'Contributing', link: '/contributing/' },
        { text: 'Releases', link: `${GITHUB_URL}/releases` },
        { text: 'Issues', link: `${GITHUB_URL}/issues` },
      ],
    },
    { text: 'GitHub', link: GITHUB_URL },
  ]
}

function sidebarGuide(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: 'Getting started',
      items: [
        { text: 'Introduction', link: '/guide/introduction' },
        { text: 'Getting started', link: '/guide/getting-started' },
        { text: 'Project structure', link: '/guide/project-structure' },
        { text: 'Examples', link: '/examples' },
      ],
    },
    {
      text: 'Concepts',
      items: [
        { text: 'Dependency injection', link: '/guide/dependency-injection' },
        { text: 'Scopes', link: '/guide/scopes' },
        { text: 'Lifecycle', link: '/guide/lifecycle' },
        { text: 'Plugins & hooks', link: '/guide/plugins' },
        { text: 'Method interceptors (AOP)', link: '/guide/aop' },
        { text: 'The compiler', link: '/guide/compiler' },
      ],
    },
    {
      text: 'Building applications',
      items: [
        { text: 'Data access', link: '/guide/data-access' },
        { text: 'Security', link: '/guide/security' },
        { text: 'Scheduling', link: '/guide/scheduling' },
        { text: 'Testing', link: '/guide/testing' },
        { text: 'Deployment', link: '/guide/deployment' },
        { text: 'Migrating from NestJS', link: '/guide/migrating-from-nestjs' },
      ],
    },
    {
      text: 'Project',
      collapsed: true,
      items: [
        { text: 'Roadmap', link: '/roadmap' },
        { text: 'Contributing guide', link: '/contributing/' },
        { text: 'Architecture', link: '/contributing/architecture' },
      ],
    },
  ]
}

function sidebarPackages(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: 'Packages',
      items: [{ text: 'Overview', link: '/packages/' }],
    },
    {
      text: 'Foundation',
      items: [
        { text: '@znight/core', link: '/packages/core' },
        { text: '@znight/compiler', link: '/packages/compiler' },
      ],
    },
    {
      text: 'Features',
      items: [
        { text: '@znight/http', link: '/packages/http' },
        { text: '@znight/openapi', link: '/packages/openapi' },
        { text: '@znight/messaging', link: '/packages/messaging' },
        { text: '@znight/schedule', link: '/packages/schedule' },
        { text: '@znight/config', link: '/packages/config' },
        { text: '@znight/observability', link: '/packages/observability' },
      ],
    },
    {
      text: 'Tooling',
      items: [
        { text: '@znight/testing', link: '/packages/testing' },
        { text: '@znight/cli', link: '/packages/cli' },
      ],
    },
  ]
}

function sidebarReference(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: 'Reference',
      items: [
        { text: 'Error codes', link: '/reference/error-codes' },
        { text: 'Decorators', link: '/reference/decorators' },
        { text: 'Architecture specification', link: '/contributing/architecture' },
      ],
    },
  ]
}

function normalizeBase(value: string | undefined): string {
  if (value === undefined || value === '') return '/'
  return `/${value.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')
}

/** Absolute URL of a public asset when the site URL is known, a base-relative path otherwise. */
function absoluteUrl(asset: string): string {
  return `${siteUrl ?? ''}${base}${asset}`
}

/** Version of the framework (all `@znight/*` packages are versioned in lockstep). */
function readVersion(): string {
  const manifest = readFileSync(resolve(repoRoot, 'packages/core/package.json'), 'utf8')
  const { version } = JSON.parse(manifest) as { version?: unknown }
  return typeof version === 'string' ? version : '0.0.0'
}
